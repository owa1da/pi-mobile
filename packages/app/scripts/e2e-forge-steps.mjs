// Journey steps for the native forge screens: each one opens a screen from the `/` menu of a
// dedicated fake pi window (pi-forge, three prompts so it has checkpoints), performs its main action
// and asserts the fake pi saw it (its remote log). The fake answers in forge's v1.2 shapes. The
// window is killed at the end without a trace on the dashboard, so the later steps' counts are
// unchanged. Every text field is typed into, and each type is checked to land in its field with
// the sheet or screen still open (the /pause bug: typing in a sheet left the app on Hosts).

import fs from "node:fs";
import path from "node:path";
import * as A from "./e2e-adb.mjs";
import * as E from "./e2e-emulator.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const PROMPTS = ["Add a token bucket", "Write tests for it", "Update the README"];

// ---------- helpers shared with the real-forge steps ----------

export async function kbDown() {
  await sleep(1000);
  if (A.keyboardShown()) {
    A.key(A.KEY.BACK);
    await sleep(700);
  }
}

export async function typeInto(id, text) {
  await A.tap(A.byId(id), id);
  A.typeText(text);
  await sleep(500);
}

/**
 * Types into a field of an open sheet or screen and checks it landed: the field holds the text,
 * `holder` (the sheet's or screen's testID) is still on screen, and the app never left for the
 * dashboard or Hosts.
 */
export async function typeChecked(id, text, holder, { expect = text } = {}) {
  await typeInto(id, text);
  await sleep(400);
  const nodes = A.dump();
  assert(!nodes.find(A.byId("hosts-list")), `typing into ${id} left the app on Hosts`);
  assert(!nodes.find(A.byId("dashboard-composer")), `typing into ${id} left the session`);
  assert(nodes.find(A.byId(holder)), `typing into ${id} closed ${holder}`);
  const field = nodes.find(A.byId(id));
  assert(field, `${id} left the screen while typing (keyboard covered it, focus lost)`);
  assert(field.text === expect, `${id} holds "${field.text}", typed "${expect}"`);
}

export function deleteChars(n) {
  A.adb("shell", "input", "keyevent", ...Array.from({ length: n }, () => String(A.KEY.DEL)));
}

/** Opens a forge screen or sheet by tapping its row in the composer's `/` menu. */
export async function slash(name) {
  await A.waitNode(A.byId("chat-composer"), 20_000, "composer");
  await typeInto("chat-composer", `/${name}`);
  // Close the keyboard here, on the chat (no sheet yet).
  await kbDown();
  await A.tap(A.byId(`slash-row-${name}`), `/${name} row`);
  await sleep(1200);
}

/**
 * The `/` menu offers /mcp login, logout and reconnect and never bare /mcp (pi's MCP manager is a
 * terminal-only view); picking reconnect completes the line, which is then sent.
 */
export async function mcpFromMenu() {
  await A.waitNode(A.byId("chat-composer"), 20_000, "composer");
  await typeInto("chat-composer", "/mcp");
  await kbDown();
  await A.waitNode(A.byId("slash-row-mcp-reconnect"), 10_000, "/mcp reconnect row");
  const nodes = A.dump();
  for (const sub of ["login", "logout", "reconnect"])
    assert(nodes.find(A.byId(`slash-row-mcp-${sub}`)), `no /mcp ${sub} row`);
  assert(!nodes.find(A.byId("slash-row-mcp")), "the menu offers bare /mcp (terminal-only)");
  await A.tap(A.byId("slash-row-mcp-reconnect"), "/mcp reconnect row");
  await sleep(500);
  const field = A.find(A.byId("chat-composer"));
  assert(field?.text === "/mcp reconnect ", `composer holds "${field?.text}"`);
  await kbDown();
  await A.tap(A.byId("chat-send"), "send /mcp reconnect");
}

/** Sends a `/` line from the composer (a row forge runs with command.run). */
export async function sendLine(line) {
  await A.waitNode(A.byId("chat-composer"), 20_000, "composer");
  await typeInto("chat-composer", line);
  await kbDown();
  await A.tap(A.byId("chat-send"), `send ${line}`);
}

/** Where an open sheet's top sits, as a fraction of the screen's height (0 = top). */
export function sheetTopFraction(sheetId) {
  const node = A.find(A.byId(sheetId));
  assert(node, `${sheetId} not on screen`);
  const [, H] = A.screenSize();
  return node.bounds[1] / H;
}

/** A content-fitted sheet rests at its content's height, never at a fixed 90% (item 3). */
export async function assertSheetRests(sheetId, minTop, notes) {
  await sleep(900);
  const top = sheetTopFraction(sheetId);
  notes?.push(`${sheetId} top at ${(top * 100).toFixed(0)}% of the screen`);
  assert(top >= minTop, `${sheetId} rests too tall: top at ${(top * 100).toFixed(0)}%`);
}

/** Back to the session's chat. */
export async function leave() {
  await kbDown();
  A.key(A.KEY.BACK);
  await sleep(800);
  await A.waitNode(A.byId("chat-composer"), 20_000, "back on the chat");
}

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
        // v1.2: exactly the desktop line: model · effort · ctx · ~$cost · its items.
        const sub = await A.waitNode(
          (n) =>
            n.id === "session-state" && /· ctx \d+%\/200k · ~\$0\.\d{3,4} · 1 shell$/.test(n.text),
          20_000,
          "footer items in the sub-bar",
        );
        // Exactly forge's segments: no state word or glyph before the model (item 1).
        assert(sub.text.startsWith("Fake 1 · medium · ctx"), `footer: "${sub.text}"`);
        {
          // v14 item 1: ONE line right under the input (status-line.md:9), not under the title.
          const nodes = A.dump();
          const input = nodes.find(A.byId("chat-composer"));
          const line = nodes.find(A.byId("session-state"));
          const send = nodes.find(A.byId("chat-send"));
          const bottom = Math.max(input.bounds[3], send?.bounds[3] ?? 0);
          assert(line.bounds[1] >= bottom, `footer ${line.bounds} not under input ${input.bounds}`);
          assert(
            line.bounds[1] - bottom < 80,
            `footer ${line.bounds[1] - bottom}px under the input`,
          );
          const [, sh] = A.screenSize();
          assert(line.bounds[3] <= sh, "footer below the screen");
        }
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
        assert(A.find(A.byId("rewind-sentence")), "no 'The code will be restored' sentence");
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
        await A.waitNode(A.byText(/^export class TokenBucket \{$/), 20_000, "diff lines");
        shot("106-diff-dark");
        // Long lines wrap inside the screen, after their gutter: nothing is cut at the edge.
        const long = A.find((n) => n.text.startsWith("Each IP gets a token bucket"));
        assert(long, "the long README line is missing");
        const [lx1, ly1, lx2, ly2] = long.bounds;
        assert(lx1 > 0 && lx2 <= 1080, `diff line runs off screen: ${long.bounds}`);
        assert(ly2 - ly1 > 60, `the long diff line did not wrap (${ly2 - ly1}px tall)`);
        ctx.notes.push(`diff wraps: long line ${ly2 - ly1}px tall, x ${lx1}..${lx2}`);
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
        await A.waitNode(A.byId("side-composer"), 20_000, "side composer");
        await A.waitNode(A.byId("side-empty"), 20_000, "side before its first message");
        {
          // forge's side draws nothing before its first message: no chip, no intro (item 2).
          const nodes = A.dump();
          assert(!nodes.some(A.byText(/^Side conversation$/)), "the side chip is back");
          assert(!nodes.some(A.byText(/runs next to this one/)), "the side intro is back");
          assert(!nodes.some(A.byId("side-badge")), "the side badge is back");
        }
        {
          // v14 item 6: blank, with the composer focused for the first line.
          await sleep(800);
          const field = A.find(A.byId("side-composer"));
          assert(field?.focused, "the empty side's composer is not focused");
        }
        shot("109-side-empty-dark");
        const since = mark();
        await typeChecked("side-composer", "What is a token bucket", "side-composer");
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
      "Forge: /btw asks (pending, answer), forks into the side, fails (error, Close), clears",
      async () => {
        await slash("btw");
        await A.waitNode(A.byId("btw-composer"), 20_000, "btw composer");
        const since = mark();
        await typeChecked("btw-composer", "Is a token bucket fair", "btw-history");
        await kbDown();
        await A.tap(A.byId("btw-send"), "btw send");
        await acted("btw.ask", since, (e) => e.args?.text === "Is a token bucket fair");
        // v14 item 5: the question, then forge's muted `Answering…` in the answer's place, read
        // from ONE dump (scoped to the pending block: other mounted screens hold the same words),
        // and the shot taken right after it.
        const pendingTexts = await E.waitFor(
          () => {
            const nodes = A.dump();
            const box = nodes.find(A.byId("btw-pending"));
            if (!box) return null;
            const within = (n) =>
              n.bounds[0] >= box.bounds[0] &&
              n.bounds[1] >= box.bounds[1] &&
              n.bounds[2] <= box.bounds[2] &&
              n.bounds[3] <= box.bounds[3];
            const texts = nodes.filter((n) => n.text && within(n)).map((n) => n.text);
            return texts.includes("Answering…") ? texts : null;
          },
          10_000,
          "btw pending block with Answering…",
        );
        assert(
          pendingTexts.includes("Is a token bucket fair"),
          `pending block: ${pendingTexts.join(" | ")}`,
        );
        assert(
          !pendingTexts.some((x) => /A token bucket holds/.test(x)),
          "answer inside the pending block",
        );
        shot("111a-btw-pending-dark");
        await A.waitNode(A.byId("btw-item-0"), 20_000, "btw answer");
        await A.waitNode(A.byText(/A token bucket holds/), 10_000, "answer text");
        // One way out, as forge's panel (Esc to close): the header's Back only (item 10).
        assert(!A.find(A.byId("btw-close")), "btw shows a second exit (Close)");
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
        // A failed answer writes no entry: forge's state says why, and Close closes its panel.
        await typeChecked("btw-composer", "will this fail", "btw-history");
        await kbDown();
        await A.tap(A.byId("btw-send"), "btw send (fails)");
        // Item 10: pi's raw "Unknown provider: unknown" reads as plain copy.
        await A.waitNode(A.byText(/^pi has no model set up to answer this/), 20_000, "btw error");
        assert(!A.find(A.byText(/Unknown provider/)), "the raw provider error leaks");
        assert(A.find(A.byId("btw-error")), "no btw-error block");
        shot("113a-btw-error-dark");
        auditControls(ctx, "btw", [["Clear", A.byId("btw-clear")]]);
        const s1 = mark();
        // Leaving the screen closes forge's panel, as Esc does there.
        await leave();
        await acted("btw.close", s1);
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
      "Forge: /tasks rows; a shell's log + stop; an agent resumed with a message; a run resumed",
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
        await A.waitNode(
          (n) => n.id === "agent-composer" && /resume the agent/.test(n.text),
          10_000,
          "the composer resumes a finished agent",
        );
        shot("116-task-agent-dark");
        since = mark();
        // v1.2: a resume starts the agent's turn, so it carries the message (agent.resume {key, text}).
        await typeChecked("agent-composer", "Also check the timer", "task-status");
        await kbDown();
        await A.tap(A.byId("agent-send"), "agent send");
        const resumed = await acted("agent.resume", since);
        assert(resumed.args?.text === "Also check the timer", JSON.stringify(resumed.args));
        await A.waitNode(A.byText(/agent: resumed, Also check the timer/), 20_000, "agent reply");
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
      "Forge: /model as forge's picker (pins until you type, no Recent, name-only rows, chips wrap whole)",
      async () => {
        await slash("model");
        await A.waitNode(A.byId("thinking-high"), 20_000, "thinking levels");
        await A.waitNode(A.byText("Pinned"), 20_000, "Pinned group");
        let nodes = A.dump();
        assert(!nodes.find(A.byText("Recent")), "a Recent group forge's picker does not show");
        assert(!nodes.find(A.byText("All models")), "the catalogue before any search");
        assert(
          !nodes.find(A.byId("model-row-google/gemini-3-pro")),
          "an unpinned model with no query",
        );
        assert(!nodes.find(A.byText("anthropic/claude-opus-5-5")), "a raw provider/id subtitle");
        const chips = nodes.filter(
          (n) => n.id.startsWith("thinking-") && n.id !== "thinking-levels",
        );
        // Item 7: one wrapping row, every chip whole on screen, no sideways scroll.
        const [sw] = A.screenSize();
        const levelsBox = nodes.find(A.byId("thinking-levels"));
        assert(chips.length >= 3, `only ${chips.length} thinking chips`);
        assert(!levelsBox?.scrollable, "the thinking chips scroll sideways");
        for (const chip of chips)
          assert(
            chip.bounds[0] >= 0 && chip.bounds[2] <= sw && chip.bounds[3] - chip.bounds[1] >= 100,
            `thinking chip ${chip.id} clipped: ${chip.bounds}`,
          );
        const tops = new Set(chips.map((n) => n.bounds[1]));
        // v15 item 7: pi's six levels as 3×2 at font scale 1.0 (as at 2.0).
        assert(chips.length === 6, `${chips.length} thinking chips (pi has 6)`);
        assert(tops.size === 2, `thinking chips on ${tops.size} rows (3×2 expected)`);
        for (const top of tops)
          assert(
            chips.filter((n) => n.bounds[1] === top).length === 3,
            "the thinking chips' rows are not 3 and 3",
          );
        ctx.notes.push(`thinking chips: ${chips.length} on ${tops.size} row(s)`);
        shot("118-model-dark");
        auditControls(ctx, "model", [
          ["thinking chip", A.byId("thinking-high")],
          ["pin toggle", A.byId("model-pin-openai/gpt-6")],
          ["search", A.byId("model-search")],
        ]);
        const since = mark();
        await A.tap(A.byId("thinking-high"), "high");
        await acted("thinking.set", since, (e) => e.args?.level === "high");
        await A.waitNode((n) => n.id === "thinking-high" && n.selected, 10_000, "high selected");
        await typeChecked("model-search", "gemini", "model-list");
        await kbDown();
        await A.waitNode(A.byId("model-row-google/gemini-3-pro"), 10_000, "search finds gemini");
        await A.tap(A.byId("model-pin-google/gemini-3-pro"), "pin gemini");
        await acted("pin.toggle", since, (e) => e.args?.ref === "google/gemini-3-pro");
        await A.waitNode(A.byText("Unpin Gemini 3 Pro"), 15_000, "gemini pinned");
        await A.tap(A.byId("model-search-clear"), "clear search");
        await A.waitNode(A.byId("model-row-google/gemini-3-pro"), 10_000, "gemini under Pinned");
        await typeChecked("model-search", "sonnet", "model-list");
        await kbDown();
        const sonnet = await A.waitNode(
          A.byId("model-row-anthropic/claude-sonnet-5"),
          10_000,
          "sonnet row",
        );
        shot("119-model-all-dark");
        A.tapNode(sonnet);
        await acted("model.set", since, (e) => e.args?.ref === "anthropic/claude-sonnet-5");
        await A.waitNode(A.byId("chat-composer"), 20_000, "back on the chat");
        const sub = await A.waitNode(
          (n) =>
            n.id === "session-state" && /Sonnet 5 · high · ctx \d+%\/200k · ~\$\d/.test(n.text),
          20_000,
          "footer with the new model",
        );
        ctx.notes.push(`footer after /model: "${sub.text}"`);
        shot("120-footer-after-model-dark");
      },
    ],
    [
      "Forge: /usage shows plan numbers and refreshes; /cost shows pi's Session Info sections",
      async () => {
        await slash("usage");
        await A.waitNode(
          A.byText(/^5-hour, 93% left, Resets in 5h (29|30)m$/),
          20_000,
          "meter with its reset words",
        );
        assert(A.find(A.byText("Claude · Max 20x")), "account heading (name · plan)");
        shot("121-usage-dark");
        const since = mark();
        await A.tap(A.byId("usage-refresh"), "refresh");
        await acted("usage.refresh", since, (e) => e.args?.force === true);
        await leave();
        await slash("cost");
        await A.waitNode(A.byText(/^Total, \$\d+\.\d{3}$/), 20_000, "cost total row");
        assert(A.find(A.byText("Messages")), "no Messages section");
        assert(A.find(A.byText("Tokens")), "no Tokens section");
        shot("122-cost-dark");
        await leave();
      },
    ],
    [
      "Forge: /pause types its fields (stays open), sets a 30-minute wake-up, shows it, cancels; Back while it rises",
      async () => {
        await slash("pause");
        await A.waitNode(A.byId("pause-value"), 15_000, "pause sheet");
        const since = mark();
        // The Message field first: typing there left the app on Hosts before the fix.
        await typeChecked("pause-reason", "waiting for CI", "pause-sheet");
        await typeChecked("pause-value", "30", "pause-sheet");
        await kbDown();
        const filled = A.dump();
        const minutes = filled.find(A.byId("pause-value"))?.text;
        const message = filled.find(A.byId("pause-reason"))?.text;
        assert(
          minutes === "30" && message === "waiting for CI",
          `pause fields "${minutes}" / "${message}"`,
        );
        await assertSheetRests("pause-sheet", 0.3, ctx.notes);
        shot("123-pause-sheet-dark");
        auditControls(ctx, "pause sheet", [["Pause", A.byId("forge-sheet-submit")]]);
        await A.tap(A.byId("forge-sheet-submit"), "Pause");
        const ev = await acted("wake.set", since);
        // forge reads a number `in` as seconds.
        assert(
          ev.args?.in === 1800 && ev.args?.reason === "waiting for CI",
          JSON.stringify(ev.args),
        );
        await A.waitGone(A.byId("pause-value"), 10_000, "pause sheet to close");
        await A.waitNode(
          (n) => n.id === "session-state" && /◷ wakes in (29|30)m$/.test(n.text),
          15_000,
          "the wake-up in the footer",
        );
        {
          // forge's drop order: parts go whole (the effort first, never without its model) and the
          // right-most item stays whole: never "◷ wakes i…". Without the old state word the
          // whole line may now fit; either way it is forge's segments only.
          const line = A.find(A.byId("session-state"))?.text ?? "";
          assert(/ · ◷ wakes in (29|30)m$/.test(line), `the wake item was cut: "${line}"`);
          assert(
            !line.includes(" · high · ") || line.startsWith("Sonnet 5 · high"),
            `the effort shows without its model: "${line}"`,
          );
          assert(
            !/^(Idle|Working|Needs input)/.test(line),
            `a state word in the footer: "${line}"`,
          );
          ctx.notes.push(`footer fitted: "${line}"`);
        }
        await slash("pause");
        await A.waitNode(
          A.byText(/^Wakes at \d+:\d{2} [AP]M · in (29|30)m · waiting for CI$/),
          15_000,
          "pending wake-up",
        );
        shot("124-pause-pending-dark");
        // Item 9: editing a pending wake-up starts from its message.
        const reasonField = A.find(A.byId("pause-reason"));
        assert(reasonField?.text === "waiting for CI", `Message holds "${reasonField?.text}"`);
        await A.tap(A.byId("pause-cancel-wake"), "cancel wake-up");
        await acted("wake.cancel", since);
        await A.waitGone(A.byId("pause-value"), 10_000, "pause sheet to close");
        // Back pressed while the sheet is still rising closes the sheet, never the session.
        await typeInto("chat-composer", "/pause");
        await kbDown();
        A.tapNode(await A.waitNode(A.byId("slash-row-pause"), 10_000, "/pause row"));
        await sleep(300);
        A.key(A.KEY.BACK);
        await sleep(1500);
        assert(A.find(A.byId("chat-composer")), "Back while the sheet rose left the session");
        assert(!A.find(A.byId("pause-value")), "Back while the sheet rose left it open");
      },
    ],
    [
      "Forge: /export (path typed, then the exists → overwrite confirm), /rename, /sync, /changelog",
      async () => {
        let since = mark();
        for (const overwrite of [false, true]) {
          await slash("export");
          await typeChecked("export-path-field", "notes/session.md", "export-sheet");
          await kbDown();
          await A.tap(A.byId("forge-sheet-submit"), "Export");
          if (overwrite) {
            await A.waitNode(A.byId("export-exists"), 15_000, "overwrite question");
            shot("126-export-overwrite-dark");
            await A.tap(A.byId("forge-sheet-submit"), "Overwrite");
            await acted("export.run", since, (e) => e.args?.overwrite === true && e.code === "ok");
          }
          await A.waitNode(A.byText(/\/notes\/session\.md$/), 15_000, "exported path");
          // The result settles the sheet back to its content (no keyboard, no 90%).
          assert(!A.keyboardShown(), "the keyboard stayed up over the export result");
          await assertSheetRests("export-sheet", 0.55, ctx.notes);
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
        await sleep(600);
        const renamed = A.dump();
        assert(renamed.find(A.byId("rename-sheet")), "typing a name closed the rename sheet");
        assert(
          renamed.find(A.byId("rename-field"))?.text === "Rate limiter",
          "the name did not land in its field",
        );
        await kbDown();
        await assertSheetRests("rename-sheet", 0.55, ctx.notes);
        shot("127-rename-dark");
        await A.tap(A.byId("forge-sheet-submit"), "Rename");
        await acted("session.rename", since, (e) => e.args?.name === "Rate limiter");
        await A.waitNode(A.byText("Rate limiter"), 15_000, "renamed title");
        await slash("sync");
        await A.waitNode(A.byText(/up to date with origin/), 20_000, "sync status");
        shot("128-sync-dark");
        await A.tap(A.byId("forge-sheet-submit"), "Sync");
        await acted("sync.run", since);
        await A.waitNode((n) => n.id === "sync-text" && n.text === "Synced", 15_000, "synced");
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
      "Forge: the / menu offers /mcp login|logout|reconnect (never bare /mcp); reconnect's select answered",
      async () => {
        const since = mark();
        await mcpFromMenu();
        await acted("command.run", since, (e) => e.line === "/mcp reconnect");
        await A.waitNode(A.byText(/^MCP server$/), 20_000, "mcp select");
        shot("130-mcp-select-dark");
        await A.tap(A.byId("prompt-option-0"), "github");
        await acted("prompt.respond", since, (e) => e.value === "github");
        await A.waitGone(A.byId("prompt-panel"), 15_000, "select closed");
      },
    ],
    [
      "Forge: /branch follows the new session in the same pi; /clear confirms, then follows",
      async () => {
        const since = mark();
        const before = sessionIdOf(pid());
        await slash("branch");
        await typeChecked("branch-field", "Leaky bucket", "branch-sheet");
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
        {
          // v15 item 4: the header's back arrow is the only way back (no second Back button).
          const nodes = A.dump();
          assert(!nodes.some(A.byId("forge-update-back")), "the extra Back button is shown");
          const backs = nodes.filter(
            (n) => n.clickable && (n.text === "Back" || n.desc === "Back"),
          );
          assert(backs.length === 1, `${backs.length} Back controls on the Update forge screen`);
        }
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
