// Journey steps against REAL forge (PIM_E2E_REAL_PI=1): the sandbox's real pi loads the forge
// worktree, offline, with no auth. Its sandbox gives it an offline model (models.json, nothing
// listens), two MCP servers that cannot start (mcp.json) and the `/pimbg` rig command (a real
// background shell through forge's own job runner). Every screen is opened from the `/` menu and
// its main action round-trips against real forge; the outcome is checked in forge's own state.json
// (or on disk / in pi's TUI). Rewind, diff/restore, side and agents need a model turn or a
// checkpoint, so they stay covered by the fake pi (e2e-forge-steps.mjs).

import fs from "node:fs";
import path from "node:path";
import * as A from "./e2e-adb.mjs";
import * as E from "./e2e-emulator.mjs";
import {
  assertSheetRests,
  deleteChars,
  kbDown,
  leave,
  mcpFromMenu,
  sendLine,
  slash,
  typeChecked,
} from "./e2e-forge-steps.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** The real pi's procs record (found by its tmux pane; its pid may sit under a shell). */
function realRecord() {
  const pane = E.readState().windows.real.pane;
  for (const file of fs.readdirSync(E.PROCS).filter((f) => f.endsWith(".json"))) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(E.PROCS, file), "utf8"));
      if (record.tmux?.pane === pane) return record;
    } catch {
      // partially written
    }
  }
  throw new Error(`no procs record for the real pi pane ${pane}`);
}

/** Waits until real forge's state.json satisfies `pred`; returns it. */
function forgeState(pred, label, timeoutMs = 20_000) {
  return E.waitFor(
    () => {
      const s = E.remoteState(realRecord().pid);
      return s && pred(s) ? s : undefined;
    },
    timeoutMs,
    `real forge state: ${label}`,
  );
}

const subBar = (re, label) =>
  A.waitNode((n) => n.id === "session-state" && re.test(n.text), 20_000, label);

// A test-only input handler consumes feedback text before any model turn. The real
// Forge input.submit still traverses its normal editor.onSubmit path.
export async function prepareFeedbackRig() {
  if (process.env.PIM_E2E_FEEDBACK !== "1" || !E.readState().windows.real) return;
  const file = path.join(E.ROOT, "pimrig.ts");
  const source = fs.readFileSync(file, "utf8");
  const anchor = "export default function (pi) {";
  assert(source.split(anchor).length === 2, "unexpected offline rig source");
  fs.writeFileSync(
    file,
    source.replace(
      anchor,
      `${anchor}
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.onTerminalInput((data) => {
      appendFileSync(join(process.env.PI_CODING_AGENT_DIR, "feedback-terminal.jsonl"), JSON.stringify({ data }) + "\\n");
    });
  });
  pi.on("input", async (event, ctx) => {
    if (!event.text.startsWith("Native feedback send")) return { action: "continue" };
    const before = ctx.ui.getEditorText();
    appendFileSync(join(process.env.PI_CODING_AGENT_DIR, "feedback-input.jsonl"), JSON.stringify({ text: event.text, source: event.source, draftBefore: before }) + "\\n");
    setTimeout(() => appendFileSync(join(process.env.PI_CODING_AGENT_DIR, "feedback-draft.jsonl"), JSON.stringify({ draftAfter: ctx.ui.getEditorText() }) + "\\n"), 500);
    return { action: "handled" };
  });`,
    ),
  );
  const binary = process.env.PIM_E2E_REAL_BINARY;
  assert(binary?.startsWith("/var/tmp/"), "feedback real pi must use an isolated binary wrapper");
  E.tmux("respawn-pane", "-k", "-t", E.readState().windows.real.pane, binary);
  await E.waitFor(
    () => {
      try {
        return realRecord() && E.remoteState(realRecord().pid)?.input?.submit;
      } catch {
        return false;
      }
    },
    30_000,
    "offline feedback rig ready",
  );
}

export function realForgeSteps(ctx, { shot, auditControls, toDashboard, scrollUntil }) {
  const real = () => Boolean(E.readState().windows.real);
  const skip = (name) => {
    ctx.notes.push(`real forge ${name}: skipped (PIM_E2E_REAL_PI unset)`);
  };
  async function openReal() {
    await toDashboard();
    A.tapNode(await scrollUntil(A.byId(`session-row-${realRecord().sessionId}`), "real pi row"));
    await A.waitNode(A.byId("chat-composer"), 30_000, "real pi chat");
    await sleep(1500);
  }

  return [
    [
      "Feedback: real Forge native send preserves an actual multiline Unicode desktop draft exactly once",
      async () => {
        if (process.env.PIM_E2E_FEEDBACK !== "1" || !real()) return skip("feedback send");
        await openReal();
        const draft =
          "Desktop draft αβ — café\nsecond line 日本語 🐱\n  keep spaces and punctuation!";
        const text = "Native feedback send from phone\nsecond explicit line!";
        const buffer = path.join(E.ROOT, "desktop-draft.txt");
        fs.writeFileSync(buffer, draft);
        const pane = E.readState().windows.real.pane;
        E.tmux("load-buffer", "-b", "feedback-draft", buffer);
        E.tmux("paste-buffer", "-d", "-p", "-b", "feedback-draft", "-t", pane);
        await forgeState((s) => s.draft === true, "actual desktop draft present");
        const remoteDir = path.join(
          E.AGENT,
          "forge",
          "remote",
          String(realRecord().pid),
          "results",
        );
        const previous = new Set(fs.readdirSync(remoteDir));
        await typeChecked("chat-composer", text.split("\n")[0], "chat-list");
        A.key(A.KEY.ENTER);
        A.typeText(text.split("\n")[1]);
        await kbDown();
        assert(
          A.find(A.byId("chat-composer"))?.text === text,
          "mobile multiline text changed before Send",
        );
        shot("feedback-real-desktop-draft-mobile-text-dark");
        const terminalFile = path.join(E.AGENT, "feedback-terminal.jsonl");
        const terminalEvents = () =>
          fs.existsSync(terminalFile)
            ? fs
                .readFileSync(terminalFile, "utf8")
                .trim()
                .split("\n")
                .filter(Boolean)
                .map(JSON.parse)
            : [];
        const terminalBefore = terminalEvents().length;
        await A.tap(A.byId("chat-send"), "native feedback send");
        const logFile = path.join(E.AGENT, "feedback-input.jsonl");
        const draftFile = path.join(E.AGENT, "feedback-draft.jsonl");
        await E.waitFor(
          () => fs.existsSync(logFile) && fs.existsSync(draftFile),
          20_000,
          "offline native input delivered",
        );
        await sleep(5000); // include delayed clear / accidental fallback or duplicate delivery
        const inputs = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
        const drafts = fs.readFileSync(draftFile, "utf8").trim().split("\n").map(JSON.parse);
        assert(
          inputs.length === 1 && inputs[0].text === text,
          "real Forge changed or duplicated mobile text",
        );
        assert(
          inputs[0].draftBefore === draft && drafts.length === 1 && drafts[0].draftAfter === draft,
          "real desktop draft changed",
        );
        assert(!A.find(A.byId("chat-send-error")), "native send reported an error");
        const cleared = A.dump();
        const composer = cleared.find(A.byId("chat-composer"));
        // Android reports a TextInput's hint as its text when its value is empty.
        assert(
          composer &&
            (composer.text === "" || composer.text === composer.desc) &&
            cleared.find(A.byId("chat-send"))?.enabled === false,
          "mobile composer did not clear after native acknowledgement",
        );
        const terminalSinceSend = terminalEvents().slice(terminalBefore);
        assert(terminalSinceSend.length === 0, "real native send injected terminal input or paste");
        const replies = fs
          .readdirSync(remoteDir)
          .filter((name) => !previous.has(name))
          .map((name) => JSON.parse(fs.readFileSync(path.join(remoteDir, name), "utf8")));
        // The client consumes/deletes the result after checking code=ok; it clears
        // the composer only after that success (asserted above). A retained reply
        // is therefore a failure, not evidence of acknowledgement.
        assert(replies.length === 0, "native acknowledgement was not consumed by the client");
        fs.writeFileSync(
          path.join(ctx.screens, `feedback-native-send-${ctx.light ? "light" : "dark"}.json`),
          JSON.stringify(
            {
              inputs,
              drafts,
              replies,
              acknowledgement: "consumed-by-client",
              terminalSinceSend,
              composer,
            },
            null,
            2,
          ),
        );
        shot("feedback-real-desktop-draft-preserved-dark");
        // One Ctrl+C clears the entire fixture editor (Ctrl+U only clears its current line).
        E.tmux("send-keys", "-t", pane, "C-c");
        await forgeState((s) => s.draft === false, "fixture desktop draft cleared");
        await toDashboard();
      },
    ],
    [
      "Real forge: the status line, /model (thinking, pin, model; footer follows)",
      async () => {
        if (!real()) return skip("model");
        await openReal();
        const sub = await subBar(/Fake Tiny · medium · ctx 0%\/100k$/, "real footer");
        ctx.notes.push(`real forge footer: "${sub.text}"`);
        shot("140-real-footer-dark");
        // Item 7: a session with no messages shows just the composer, never an endless spinner.
        await sleep(3000);
        const spin = A.dump().find((n) => /^Loading (messages|session)$/.test(n.desc));
        assert(!spin, `an empty session still spins: "${spin?.desc}"`);
        await slash("model");
        await A.waitNode(A.byId("thinking-high"), 20_000, "real thinking levels");
        assert(!A.find(A.byId("thinking-xhigh")), "a level forge does not offer is shown");
        shot("141-real-model-dark");
        auditControls(ctx, "real model", [["thinking chip", A.byId("thinking-high")]]);
        await A.tap(A.byId("thinking-high"), "high");
        await forgeState((s) => s.footer?.model?.thinking === "high", "thinking high");
        await A.waitNode((n) => n.id === "thinking-high" && n.selected, 10_000, "high selected");
        await typeChecked("model-search", "plain", "model-list");
        await kbDown();
        await A.waitNode(A.byId("model-pin-fake/plain"), 10_000, "search finds Fake Plain");
        await A.tap(A.byId("model-pin-fake/plain"), "pin Fake Plain");
        await forgeState((s) => s.pins?.pinned?.includes("fake/plain"), "fake/plain pinned");
        await A.waitNode(A.byText("Unpin Fake Plain"), 15_000, "Fake Plain pinned in the app");
        await A.tap(A.byId("model-search-clear"), "clear search");
        await A.waitNode(A.byText("Pinned"), 10_000, "Pinned group");
        assert(!A.find(A.byText("fake/plain")), "a raw provider/id subtitle");
        shot("142-real-model-pinned-dark");
        await A.tap(A.byId("model-row-fake/plain"), "Fake Plain");
        await A.waitNode(A.byId("chat-composer"), 20_000, "back on the chat");
        await forgeState((s) => s.footer?.model?.id === "plain", "model fake/plain");
        // A model that does not think: the line hides the effort, and so does the app.
        await subBar(/Fake Plain · ctx 0%\/50\.0k$/, "footer with Fake Plain");
        shot("143-real-footer-plain-dark");
        await slash("model");
        await A.waitNode(A.byId("model-row-fake/plain"), 20_000, "real pins again");
        assert(!A.find(A.byId("thinking-high")), "thinking levels for a model that does not think");
        await A.tap(A.byId("model-pin-fake/plain"), "unpin Fake Plain");
        await forgeState((s) => !s.pins?.pinned?.includes("fake/plain"), "fake/plain unpinned");
        await A.waitNode(A.byText("Unpinned"), 10_000, "unpinned here stays for undo");
        await typeChecked("model-search", "tiny", "model-list");
        await kbDown();
        await A.waitNode(A.byId("model-row-fake/tiny"), 10_000, "search finds Fake Tiny");
        await A.tap(A.byId("model-row-fake/tiny"), "Fake Tiny");
        await A.waitNode(A.byId("chat-composer"), 20_000, "back on the chat");
        await subBar(/Fake Tiny · high · ctx 0%\/100k$/, "footer back on Fake Tiny, high");
        await toDashboard();
      },
    ],
    [
      "Real forge: /cost (Session Info), /usage (no plan offline, refresh), /changelog, /sync status",
      async () => {
        if (!real()) return skip("info");
        await openReal();
        await slash("cost");
        await A.waitNode(A.byText("Messages"), 20_000, "cost: Messages section");
        assert(A.find(A.byText("Tokens")), "cost: no Tokens section");
        assert(
          A.find((n) => /^ID, [0-9a-f-]{36}$/.test(n.desc)),
          "cost: no ID row with the session id",
        );
        shot("144-real-cost-dark");
        await leave();
        await slash("usage");
        await A.waitNode(A.byId("usage-empty"), 20_000, "usage: no plan (offline, no auth)");
        await A.tap(A.byId("usage-refresh"), "refresh");
        await sleep(2000);
        assert(A.find(A.byId("usage-empty")), "usage after refresh");
        shot("145-real-usage-dark");
        await leave();
        await slash("changelog");
        await A.waitNode(A.byText(/1\.0\.0/), 30_000, "changelog: pi 1.0.0");
        shot("146-real-changelog-dark");
        await leave();
        await slash("sync");
        // A worktree is not the ~/.pi/forge clone: setup's check says why, at error level.
        const sync = await A.waitNode(
          (n) => n.id === "sync-text" && /setup/.test(n.text),
          40_000,
          "sync status from setup --check",
        );
        ctx.notes.push(`real sync.status: "${sync.text}"`);
        shot("147-real-sync-dark");
        await A.tap(A.byId("forge-sheet-cancel"), "close sync");
        await A.waitGone(A.byId("sync-text"), 10_000, "sync sheet to close");
        await toDashboard();
      },
    ],
    [
      "Real forge: /pause set + cancel, /export (+ exists → overwrite), /rename — fields typed",
      async () => {
        if (!real()) return skip("sheets");
        await openReal();
        await slash("pause");
        await A.waitNode(A.byId("pause-value"), 15_000, "pause sheet");
        await typeChecked("pause-reason", "waiting for CI", "pause-sheet");
        await typeChecked("pause-value", "30", "pause-sheet");
        await kbDown();
        await assertSheetRests("pause-sheet", 0.3, ctx.notes);
        shot("148-real-pause-dark");
        await A.tap(A.byId("forge-sheet-submit"), "Pause");
        const woke = await forgeState((s) => Boolean(s.wake), "wake set");
        assert(woke.wake.reason === "waiting for CI", `wake reason ${woke.wake.reason}`);
        const left = woke.wake.due - Date.now();
        assert(left > 28 * 60_000 && left < 31 * 60_000, `wake due in ${Math.round(left / 1000)}s`);
        await subBar(/◷ wakes in (29|30)m$/, "real footer item: the wake-up");
        await slash("pause");
        await A.waitNode(
          A.byText(/^Wakes at \d+:\d{2} [AP]M · in (29|30)m · waiting for CI$/),
          15_000,
          "pending wake-up",
        );
        shot("149-real-pause-pending-dark");
        await A.tap(A.byId("pause-cancel-wake"), "cancel wake-up");
        await forgeState((s) => s.wake === null, "wake cancelled");
        await A.waitGone(A.byId("pause-value"), 10_000, "pause sheet to close");
        const cwd = realRecord().cwd ?? path.join(E.ROOT, "work", "api");
        const kept = path.join(cwd, "notes", "keep.md");
        fs.mkdirSync(path.dirname(kept), { recursive: true });
        fs.writeFileSync(kept, "keep\n");
        await slash("export");
        await typeChecked("export-path-field", "notes/real.md", "export-sheet");
        await kbDown();
        await A.tap(A.byId("forge-sheet-submit"), "Export");
        await A.waitNode(A.byText(/\/notes\/real\.md$/), 20_000, "exported path");
        assert(fs.existsSync(path.join(cwd, "notes", "real.md")), "real.md not written");
        await assertSheetRests("export-sheet", 0.55, ctx.notes);
        shot("150-real-export-done-dark");
        await A.tap(A.byId("forge-sheet-close"), "Done");
        await A.waitGone(A.byId("forge-sheet-close"), 10_000, "export sheet to close");
        await slash("export");
        await typeChecked("export-path-field", "notes/keep.md", "export-sheet");
        await kbDown();
        await A.tap(A.byId("forge-sheet-submit"), "Export");
        // forge refuses with reason "exists": the app asks before overwriting.
        await A.waitNode(A.byId("export-exists"), 20_000, "overwrite question");
        assert(fs.readFileSync(kept, "utf8") === "keep\n", "keep.md changed before the confirm");
        shot("151-real-export-overwrite-dark");
        await A.tap(A.byId("forge-sheet-submit"), "Overwrite");
        await A.waitNode(A.byText(/\/notes\/keep\.md$/), 20_000, "overwritten path");
        assert(fs.readFileSync(kept, "utf8") !== "keep\n", "keep.md not overwritten");
        await A.tap(A.byId("forge-sheet-close"), "Done");
        await A.waitGone(A.byId("forge-sheet-close"), 10_000, "export sheet to close");
        await slash("rename");
        await A.tap(A.byId("rename-field"), "rename field");
        A.key(A.KEY.MOVE_END);
        deleteChars(60);
        A.typeText("Real forge");
        await sleep(600);
        const renamed = A.dump();
        assert(renamed.find(A.byId("rename-sheet")), "typing a name closed the rename sheet");
        assert(
          renamed.find(A.byId("rename-field"))?.text === "Real forge",
          "name not in its field",
        );
        await kbDown();
        await A.tap(A.byId("forge-sheet-submit"), "Rename");
        await E.waitFor(() => realRecord().name === "Real forge", 20_000, "pi renamed the session");
        await A.waitNode(A.byText("Real forge"), 20_000, "renamed title");
        shot("152-real-renamed-dark");
        await toDashboard();
      },
    ],
    [
      process.env.PIM_E2E_FEEDBACK === "1"
        ? "Real forge: /tasks with a real background shell (log tail, stop), no model request"
        : "Real forge: /tasks with a real background shell (log tail, stop); /btw offline (pending → error, Close)",
      async () => {
        if (!real()) return skip("tasks/btw");
        await openReal();
        await sendLine("/pimbg");
        await E.waitFor(
          () => E.rigLog().some((l) => l.startsWith("bg=ticker")),
          20_000,
          "rig shell",
        );
        await subBar(/· 1 shell$/, "real footer item: 1 shell");
        await slash("tasks");
        const row = await A.waitNode(
          (n) => n.id.startsWith("task-row-shell:") && n.id.endsWith("/ticker"),
          20_000,
          "the ticker shell row",
        );
        assert(/^ticker, running$/.test(row.desc), `shell row "${row.desc}"`);
        shot("153-real-tasks-dark");
        A.tapNode(row);
        await A.waitNode(A.byText(/tick \d+/), 20_000, "the shell's log tail (task.tail)");
        shot("154-real-task-tail-dark");
        const task = (
          await forgeState((s) => (s.tasks ?? []).some((t) => t.name === "ticker"), "ticker")
        ).tasks.find((t) => t.name === "ticker");
        await A.tap(A.byId("task-stop"), "stop");
        await A.waitNode((n) => n.id === "task-status" && n.text === "stopped", 20_000, "stopped");
        const size = fs.statSync(task.logPath).size;
        await sleep(2500);
        assert(fs.statSync(task.logPath).size === size, "the shell still writes after Stop");
        A.key(A.KEY.BACK);
        await sleep(800);
        await leave();
        await A.waitGone(
          (n) => n.id === "session-state" && /1 shell/.test(n.text),
          15_000,
          "shell gone from the footer",
        );
        if (process.env.PIM_E2E_FEEDBACK === "1") {
          ctx.notes.push(
            "real BTW model request intentionally omitted: feedback validation forbids inference; deterministic fake BTW remains covered",
          );
          await toDashboard();
          return;
        }
        await slash("btw");
        await A.waitNode(A.byId("btw-composer"), 20_000, "btw composer");
        await typeChecked("btw-composer", "Is this offline", "btw-composer");
        await kbDown();
        await A.tap(A.byId("btw-send"), "btw send");
        // forge's btw state: pending, then the model's failure (nothing listens offline).
        await A.waitNode(
          A.byText(/^pi could not reach the model/),
          30_000,
          "btw error from real forge",
        );
        assert(A.find(A.byId("btw-error")), "no btw-error block");
        shot("155-real-btw-error-dark");
        assert(!A.find(A.byId("btw-close")), "btw shows a second exit (Close)");
        // Back is the one way out: it closes forge's panel, as Esc does in the terminal.
        await leave();
        await forgeState((s) => s.btw?.open !== true && s.view === "main", "btw panel closed");
        await toDashboard();
      },
    ],
    [
      "Real forge: the / menu offers /mcp login|logout|reconnect; reconnect's select answered in the app",
      async () => {
        if (!real()) return skip("mcp");
        await openReal();
        await mcpFromMenu();
        await A.waitNode(A.byText(/^MCP server$/), 30_000, "real forge's mcp select");
        shot("157-real-mcp-select-dark");
        const github = A.dump().find(
          (n) => n.id.startsWith("prompt-option-") && n.desc === "github",
        );
        assert(github, "no github option in pi's select");
        A.tapNode(github);
        await A.waitGone(A.byId("prompt-panel"), 20_000, "mcp select closed");
        const pane = E.readState().windows.real.pane;
        await E.waitFor(
          () => /MCP server "github"/.test(E.tmux("capture-pane", "-p", "-t", pane)),
          20_000,
          "pi's TUI reports the github reconnect",
        );
        await toDashboard();
      },
    ],
  ];
}
