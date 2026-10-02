// Journey steps for the native forge screens (Wave 12): each one opens a screen from the `/` menu
// of a dedicated fake pi window (pi-forge, three prompts so it has checkpoints), performs its main
// action and asserts the fake pi saw it (its remote log). The window is killed at the end without
// a trace on the dashboard, so the later steps' counts are unchanged.

import fs from "node:fs";
import path from "node:path";
import * as A from "./e2e-adb.mjs";
import * as E from "./e2e-emulator.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const PROMPTS = ["Add a token bucket", "Write tests for it", "Update the README"];

export function forgeSteps(ctx, { shot, auditControls, toDashboard, scrollUntil }) {
  const w = {};
  const pid = () => w.forge.pid;
  const sessionIdOf = (p) =>
    JSON.parse(fs.readFileSync(path.join(E.PROCS, `${p}.json`), "utf8")).sessionId;
  const remote = (p = pid()) => E.events(p).filter((e) => e.kind === "remote" && e.action);
  const mark = () => remote().length;
  const acted = (action, since, pred = () => true, p = pid()) =>
    E.waitFor(
      () =>
        remote(p)
          .slice(since)
          .find((e) => e.action === action && pred(e)),
      20_000,
      `fake pi saw ${action}`,
    );

  async function kbDown() {
    await sleep(1000);
    if (A.keyboardShown()) {
      A.key(A.KEY.BACK);
      await sleep(700);
    }
  }
  async function typeInto(id, text) {
    await A.tap(A.byId(id), id);
    A.typeText(text);
    await sleep(500);
  }
  function deleteChars(n) {
    A.adb("shell", "input", "keyevent", ...Array.from({ length: n }, () => String(A.KEY.DEL)));
  }
  /** Opens a forge screen or sheet by tapping its row in the composer's `/` menu. */
  async function slash(name) {
    await A.waitNode(A.byId("chat-composer"), 20_000, "composer");
    await typeInto("chat-composer", `/${name}`);
    // Close the keyboard here, on the chat (no sheet yet): a Back sent while a sheet is still
    // rising reaches the navigator, not the sheet.
    await kbDown();
    await A.tap(A.byId(`slash-row-${name}`), `/${name} row`);
    await sleep(1200);
  }
  /** Back to the forge session's chat. */
  async function leave() {
    await kbDown();
    A.key(A.KEY.BACK);
    await sleep(800);
    await A.waitNode(A.byId("chat-composer"), 20_000, "back on the chat");
  }
  async function openSession(sessionId) {
    await toDashboard();
    A.tapNode(await scrollUntil(A.byId(`session-row-${sessionId}`), "forge row"));
    await A.waitNode(A.byId("chat-composer"), 30_000, "forge chat");
    await sleep(1500);
  }

  return [
    [
      "Forge: the footer status line, then /rewind (prompts with their changes, 4 choices, confirm)",
      async () => {
        w.forge = await E.forgeWindow("pi-forge", PROMPTS);
        await openSession(sessionIdOf(pid()));
        const sub = await A.waitNode(
          (n) => n.id === "session-state" && /· ctx \d+%\/200k · \$0\.\d{3}$/.test(n.text),
          20_000,
          "footer items in the sub-bar",
        );
        assert(/Fake 1 · medium · ctx/.test(sub.text), `footer: "${sub.text}"`);
        ctx.notes.push(`forge footer: "${sub.text}"`);
        shot("100-forge-footer-dark");
        await slash("rewind");
        await A.waitNode(A.byId("rewind-list"), 20_000, "rewind list");
        await A.waitNode(
          A.byText(/^Update the README, 3 files changed \+17 -4$/),
          30_000,
          "the newest prompt's preview line",
        );
        await A.waitNode(A.byText(/^Add a token bucket, \d+ files changed/), 30_000, "oldest");
        shot("101-rewind-list-dark");
        auditControls(ctx, "rewind list", [
          ["prompt row", (n) => n.id.startsWith("rewind-row-") && n.clickable],
        ]);
        await A.tap(
          (n) => n.id.startsWith("rewind-row-") && n.desc.startsWith("Update the README"),
          "newest prompt",
        );
        await A.waitNode(A.byId("rewind-choice-conversation"), 10_000, "choices");
        for (const c of ["both", "code", "cancel"])
          assert(A.find(A.byId(`rewind-choice-${c}`)), `no ${c} choice`);
        shot("102-rewind-choices-dark");
        const since = mark();
        await A.tap(A.byId("rewind-choice-conversation"), "Restore conversation");
        await A.waitNode(A.byId("rewind-sheet-confirm"), 10_000, "rewind confirm");
        await sleep(600);
        shot("103-rewind-confirm-dark");
        await A.tap(A.byId("rewind-sheet-confirm"), "confirm rewind");
        const ev = await acted("rewind.apply", since);
        assert(ev.args?.mode === "conversation", `rewind mode ${ev.args?.mode}`);
        await A.waitNode(
          (n) => n.id === "chat-composer" && n.text === "Update the README",
          20_000,
          "the rewound prompt back in the composer",
        );
        await A.waitNode(A.byText(/Navigated to selected point/), 20_000, "rewind in chat");
        shot("104-rewind-prompt-back-dark");
        await A.tap(A.byId("chat-composer"), "composer");
        A.key(A.KEY.MOVE_END);
        deleteChars(24);
        await kbDown();
      },
    ],
    [
      "Forge: /diff lists checkpoints, shows a tinted diff, restores behind a confirm",
      async () => {
        await slash("diff");
        await A.waitNode(A.byId("checkpoint-row-2"), 20_000, "checkpoint 2");
        assert(!A.find(A.byId("checkpoint-row-3")), "the rewound checkpoint is still listed");
        shot("105-checkpoints-dark");
        await A.tap(A.byId("checkpoint-row-2"), "checkpoint 2");
        await A.waitNode(A.byText(/^\+export class TokenBucket \{$/), 20_000, "diff lines");
        shot("106-diff-dark");
        const view = A.find(A.byId("diff-view"));
        if (view) {
          const y = Math.round((view.bounds[1] + view.bounds[3]) / 2);
          A.swipe(900, y, 150, y, 400);
          await sleep(900);
          shot("107-diff-scrolled-dark");
        }
        await A.tap(A.byId("checkpoint-restore"), "Restore");
        await A.waitNode(A.byId("restore-sheet-confirm"), 10_000, "restore confirm");
        await sleep(600);
        shot("108-restore-confirm-dark");
        const since = mark();
        await A.tap(A.byId("restore-sheet-confirm"), "confirm restore");
        const ev = await acted("checkpoint.restore", since);
        assert(ev.args?.n === 2, `restored ${JSON.stringify(ev.args)}`);
        await A.waitNode(A.byId("chat-composer"), 20_000, "back on the chat");
        await A.waitNode(A.byText(/Restored to checkpoint 2/), 20_000, "restore in chat");
      },
    ],
    [
      "Forge: /side opens a marked second chat with its own composer, then closes",
      async () => {
        await slash("side");
        await A.waitNode(A.byId("side-badge"), 20_000, "side badge");
        await A.waitNode(A.byId("side-composer"), 20_000, "side composer");
        shot("109-side-empty-dark");
        const since = mark();
        await typeInto("side-composer", "What is a token bucket");
        await kbDown();
        await A.tap(A.byId("side-send"), "side send");
        const ev = await acted("side.open", since);
        assert(ev.args?.text === "What is a token bucket", `side.open ${JSON.stringify(ev.args)}`);
        await A.waitNode(A.byText(/side: A token bucket holds/), 20_000, "side reply");
        shot("110-side-chat-dark");
        await A.tap(A.byId("side-close"), "close side");
        await acted("side.close", since);
        await A.waitGone(A.byId("side-close"), 10_000, "side closed");
        await leave();
      },
    ],
    [
      "Forge: /btw asks, shows the answer from forge-btw entries, forks into the side, clears",
      async () => {
        await slash("btw");
        await A.waitNode(A.byId("btw-composer"), 20_000, "btw composer");
        const since = mark();
        await typeInto("btw-composer", "Is a token bucket fair");
        await kbDown();
        await A.tap(A.byId("btw-send"), "btw send");
        await acted("btw.ask", since, (e) => e.args?.text === "Is a token bucket fair");
        await A.waitNode(A.byId("btw-item-0"), 20_000, "btw answer");
        await A.waitNode(A.byText(/A token bucket holds/), 10_000, "answer text");
        shot("111-btw-answer-dark");
        await A.tap(A.byId("btw-fork"), "fork");
        await acted("btw.fork", since);
        await A.waitNode(A.byId("side-close"), 20_000, "forked side");
        await A.waitNode(A.byText(/^Is a token bucket fair$/), 20_000, "question in the side");
        shot("112-btw-forked-side-dark");
        await A.tap(A.byId("side-close"), "close side");
        await E.waitFor(
          () =>
            remote()
              .slice(since)
              .filter((e) => e.action === "side.close").length >= 1,
          20_000,
          "side.close",
        );
        await leave();
        await slash("btw");
        await A.waitNode(A.byId("btw-item-0"), 20_000, "history again");
        await A.tap(A.byId("btw-clear"), "clear");
        await A.waitNode(A.byId("btw-clear-sheet-confirm"), 10_000, "clear confirm");
        await sleep(600);
        shot("113-btw-clear-confirm-dark");
        const s2 = mark();
        await A.tap(A.byId("btw-clear-sheet-confirm"), "confirm clear");
        await acted("btw.clear", s2);
        await A.waitGone(A.byId("btw-item-0"), 15_000, "history cleared");
        await leave();
      },
    ],
    [
      "Forge: /tasks rows; a shell's log + stop; an agent's transcript + message + resume",
      async () => {
        await slash("tasks");
        await A.waitNode(A.byId("tasks-list"), 20_000, "tasks list");
        assert(A.find(A.byText(/^npm test -- --watch, running$/)), "shell row (name, status)");
        shot("114-tasks-dark");
        await A.tap(A.byId("task-row-sh-1"), "shell row");
        await A.waitNode(A.byText(/\$ npm test -- --watch/), 20_000, "log tail");
        shot("115-task-shell-tail-dark");
        let since = mark();
        await A.tap(A.byId("task-stop"), "stop");
        await acted("task.stop", since, (e) => e.args?.key === "sh-1");
        await A.waitNode((n) => n.id === "task-status" && n.text === "stopped", 15_000, "stopped");
        A.key(A.KEY.BACK);
        await A.waitNode(A.byId("task-row-ag-review"), 15_000, "tasks again");
        await A.tap(A.byId("task-row-ag-review"), "agent row");
        await A.waitNode(A.byText(/Two refill paths can run at once/), 20_000, "agent transcript");
        shot("116-task-agent-dark");
        since = mark();
        await typeInto("agent-composer", "Also check the timer");
        await kbDown();
        await A.tap(A.byId("agent-send"), "agent send");
        const sent = await acted("agent.send", since);
        assert(sent.args?.mode === "followUp", `agent.send ${JSON.stringify(sent.args)}`);
        await A.waitNode(A.byText(/agent: noted, Also check the timer/), 20_000, "agent reply");
        await A.tap(A.byId("task-resume"), "resume agent");
        await acted("agent.resume", since);
        shot("117-task-agent-resumed-dark");
        A.key(A.KEY.BACK);
        await A.waitNode(A.byId("task-row-wf-sweep"), 15_000, "tasks again");
        await A.tap(A.byId("task-row-wf-sweep"), "workflow row");
        await A.tap(A.byId("task-resume"), "resume workflow");
        const wf = await acted("task.resume", since);
        assert(wf.args?.runId === "20261002T101204-sweep", `runId ${wf.args?.runId}`);
        A.key(A.KEY.BACK);
        await sleep(600);
        await leave();
      },
    ],
    [
      "Forge: /model sets thinking, pins, picks a model from Pinned/Recent/All; footer follows",
      async () => {
        await slash("model");
        await A.waitNode(A.byId("thinking-high"), 20_000, "thinking levels");
        await A.waitNode(A.byText("Pinned"), 20_000, "Pinned group");
        assert(A.find(A.byText("Recent")), "no Recent group");
        shot("118-model-dark");
        auditControls(ctx, "model", [
          ["thinking chip", A.byId("thinking-high")],
          ["pin toggle", A.byId("model-pin-google/gemini-3-pro")],
        ]);
        const since = mark();
        await A.tap(A.byId("thinking-high"), "high");
        await acted("thinking.set", since, (e) => e.args?.level === "high");
        await A.tap(A.byId("model-pin-google/gemini-3-pro"), "pin gemini");
        await acted("pin.toggle", since, (e) => e.args?.ref === "google/gemini-3-pro");
        await A.waitNode(A.byText("Unpin Gemini 3 Pro"), 15_000, "gemini pinned");
        const sonnet = await scrollUntil(
          A.byId("model-row-anthropic/claude-sonnet-5"),
          "sonnet row",
          { from: [540, 1900], to: [540, 1100] },
        );
        shot("119-model-all-dark");
        A.tapNode(sonnet);
        await acted("model.set", since, (e) => e.args?.ref === "anthropic/claude-sonnet-5");
        await A.waitNode(A.byId("chat-composer"), 20_000, "back on the chat");
        const sub = await A.waitNode(
          (n) => n.id === "session-state" && /Sonnet 5 · high · ctx \d+%\/200k · \$/.test(n.text),
          20_000,
          "footer with the new model",
        );
        ctx.notes.push(`footer after /model: "${sub.text}"`);
        shot("120-footer-after-model-dark");
      },
    ],
    [
      "Forge: /usage shows plan numbers and refreshes; /cost shows the session's rows",
      async () => {
        await slash("usage");
        await A.waitNode(A.byText(/^5-hour, 93% left, Resets in 5h 30m$/), 20_000, "meter");
        shot("121-usage-dark");
        const since = mark();
        await A.tap(A.byId("usage-refresh"), "refresh");
        await acted("usage.refresh", since);
        await leave();
        await slash("cost");
        await A.waitNode(A.byText(/^Total, \$\d+\.\d{3}$/), 20_000, "cost total row");
        assert(A.find(A.byText(/^Messages, \d+$/)), "no Messages row");
        shot("122-cost-dark");
        await leave();
      },
    ],
    [
      "Forge: /pause sets a wake-up in 30 minutes with a message, shows it, cancels it",
      async () => {
        await slash("pause");
        await A.waitNode(A.byId("pause-value"), 15_000, "pause sheet");
        const since = mark();
        // Message first (the keyboard would cover it), then Minutes, which stays above the keyboard.
        await typeInto("pause-reason", "waiting for CI");
        await typeInto("pause-value", "30");
        await kbDown();
        const filled = A.dump();
        const minutes = filled.find(A.byId("pause-value"))?.text;
        const message = filled.find(A.byId("pause-reason"))?.text;
        assert(
          minutes === "30" && message === "waiting for CI",
          `pause fields "${minutes}" / "${message}"`,
        );
        shot("123-pause-sheet-dark");
        auditControls(ctx, "pause sheet", [["Pause", A.byId("forge-sheet-submit")]]);
        await A.tap(A.byId("forge-sheet-submit"), "Pause");
        const ev = await acted("wake.set", since);
        assert(ev.args?.in === 30 && ev.args?.reason === "waiting for CI", JSON.stringify(ev.args));
        await A.waitGone(A.byId("pause-value"), 10_000, "pause sheet to close");
        await slash("pause");
        await A.waitNode(
          A.byText(/^Wakes at \d+:\d{2} [AP]M · in (29|30)m · waiting for CI$/),
          15_000,
          "pending wake-up",
        );
        shot("124-pause-pending-dark");
        await A.tap(A.byId("pause-cancel-wake"), "cancel wake-up");
        await acted("wake.cancel", since);
        await A.waitGone(A.byId("pause-value"), 10_000, "pause sheet to close");
      },
    ],
    [
      "Forge: /export (path, then overwrite confirm), /rename, /sync, /changelog",
      async () => {
        let since = mark();
        for (const overwrite of [false, true]) {
          await slash("export");
          await typeInto("export-path-field", "notes/session.md");
          await kbDown();
          await A.tap(A.byId("forge-sheet-submit"), "Export");
          if (overwrite) {
            await A.waitNode(A.byId("export-exists"), 15_000, "overwrite question");
            shot("126-export-overwrite-dark");
            await A.tap(A.byId("forge-sheet-submit"), "Overwrite");
            await acted("export.run", since, (e) => e.args?.overwrite === true && e.code === "ok");
          }
          await A.waitNode(A.byText(/\/notes\/session\.md$/), 15_000, "exported path");
          if (!overwrite) shot("125-export-done-dark");
          await A.tap(A.byId("forge-sheet-close"), "Done");
          await A.waitGone(A.byId("forge-sheet-close"), 10_000, "export sheet to close");
        }
        since = mark();
        await slash("rename");
        await A.tap(A.byId("rename-field"), "rename field");
        A.key(A.KEY.MOVE_END);
        deleteChars(40);
        A.typeText("Rate limiter");
        await kbDown();
        shot("127-rename-dark");
        await A.tap(A.byId("forge-sheet-submit"), "Rename");
        await acted("session.rename", since, (e) => e.args?.name === "Rate limiter");
        await A.waitNode(A.byText("Rate limiter"), 15_000, "renamed title");
        await slash("sync");
        await A.waitNode(A.byText(/up to date with origin/), 20_000, "sync status");
        shot("128-sync-dark");
        await A.tap(A.byId("forge-sheet-submit"), "Sync");
        await acted("sync.run", since);
        await A.waitNode(A.byText(/Reloaded/), 15_000, "sync summary");
        await A.tap(A.byId("forge-sheet-cancel"), "close sync");
        await A.waitGone(A.byId("sync-text"), 10_000, "sync sheet to close");
        await slash("changelog");
        await A.waitNode(A.byText(/1\.4\.0/), 20_000, "changelog markdown");
        await acted("changelog.read", since);
        shot("129-changelog-dark");
        await leave();
      },
    ],
    [
      "Forge: /mcp runs through command.run and its select is answered in the app",
      async () => {
        const since = mark();
        await typeInto("chat-composer", "/mcp");
        await kbDown();
        await A.tap(A.byId("chat-send"), "send /mcp");
        await acted("command.run", since, (e) => e.line === "/mcp");
        await A.waitNode(A.byText(/^MCP servers$/), 20_000, "mcp select");
        shot("130-mcp-select-dark");
        await A.tap(A.byId("prompt-option-0"), "github");
        await acted("prompt.respond", since, (e) => e.value === "github · connected");
        await A.waitGone(A.byId("prompt-panel"), 15_000, "select closed");
      },
    ],
    [
      "Forge: /branch follows the new session in the same pi; /clear confirms, then follows",
      async () => {
        const since = mark();
        const before = sessionIdOf(pid());
        await slash("branch");
        await typeInto("branch-field", "Leaky bucket");
        await kbDown();
        shot("131-branch-dark");
        await A.tap(A.byId("forge-sheet-submit"), "Branch");
        await acted("session.branch", since, (e) => e.args?.name === "Leaky bucket");
        await A.waitNode(A.byText("Leaky bucket"), 20_000, "the branch's title");
        assert(sessionIdOf(pid()) !== before, "branch kept the session id");
        await A.waitNode(A.byId("chat-composer"), 10_000, "branch chat");
        await slash("clear");
        await A.waitNode(A.byText(/pi starts a new session/), 10_000, "clear confirm");
        shot("132-clear-confirm-dark");
        await A.tap(A.byId("forge-sheet-submit"), "Clear");
        await acted("session.clear", since);
        await A.waitGone(A.byText("Leaky bucket"), 20_000, "followed the cleared session");
        await A.waitNode(A.byId("chat-composer"), 10_000, "cleared chat");
        assert(!A.find(A.byId("session-not-found")), "the screen lost the session");
        shot("133-cleared-dark");
      },
    ],
    [
      'Forge: an older forge build (no areas) shows "Update forge" on its screens',
      async () => {
        w.core = await E.forgeWindow("pi-forge-old", ["Old forge"], { FAKE_PI_AREAS: "core" });
        await openSession(sessionIdOf(w.core.pid));
        await slash("rewind");
        await A.waitNode(A.byId("forge-update"), 20_000, "Update forge (rewind)");
        shot("134-update-forge-screen-dark");
        await leave();
        await slash("pause");
        await A.waitNode(A.byText(/Update forge on your computer/), 15_000, "Update forge sheet");
        shot("135-update-forge-sheet-dark");
        await A.tap(A.byId("forge-sheet-close"), "Done");
        await sleep(600);
        await toDashboard();
        await E.killWindow(w.core);
        await E.killWindow(w.forge);
        await A.waitGone(
          (n) => n.id.startsWith("session-row-") && /Rate limiter|Old forge/.test(n.desc),
          20_000,
          "forge rows to leave the dashboard",
        );
      },
    ],
  ];
}
