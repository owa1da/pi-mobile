// The automated device journey for scripts/e2e-emulator.mjs (`journey` command). Each step drives
// the real APK over adb and asserts an outcome on the device and on the isolated host (fake pi
// input logs, the private tmux server, the registry). Results go to <screens>/journey-results.json.
//
// Options: --apk PATH (default android/app/build/outputs/apk/release/app-release.apk),
//          --screens DIR (default ~/projects/pi-mobile-work/screens-v11), --keep (leave the sandbox up),
//          --no-install (use the installed APK), --stop-after N (first N steps, sandbox kept),
//          --theme dark|light (default dark: the run's
//          base appearance; with light, every "-dark" shot is taken in light mode as "-light").
// Accessibility: every main control is checked for a label and a ≥48dp (Android floor) hit area (bounds plus its
// declared hitSlop) on the device; the table goes to <screens>/a11y-audit-<theme>.json.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as A from "./e2e-adb.mjs";
import * as E from "./e2e-emulator.mjs";
import { forgeSteps } from "./e2e-forge-steps.mjs";
import { realForgeSteps } from "./e2e-real-forge-steps.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = "com.owa1da.pimobile";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function option(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function windowPid(name) {
  return E.readState().windows[name].pid;
}

/** The real pi's sessionId, found by its tmux pane (its pid may sit under a shell). */
function realSessionId() {
  const pane = E.readState().windows.real.pane;
  for (const file of fs.readdirSync(E.PROCS).filter((f) => f.endsWith(".json"))) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(E.PROCS, file), "utf8"));
      if (record.tmux?.pane === pane) return record.sessionId;
    } catch {
      // partially written record
    }
  }
  throw new Error(`no procs record for the real pi pane ${pane}`);
}

function sessionIdOf(name) {
  const record = path.join(E.PROCS, `${windowPid(name)}.json`);
  return JSON.parse(fs.readFileSync(record, "utf8")).sessionId;
}

const rowOf = (sessionId) => A.byId(`session-row-${sessionId}`);
const eventCount = (name) => E.events(windowPid(name)).length;
const eventsSince = (name, n) => E.events(windowPid(name)).slice(n);
const inputHex = (name, n) =>
  eventsSince(name, n)
    .filter((e) => e.kind === "input")
    .map((e) => e.hex);

async function back() {
  A.key(A.KEY.BACK);
  await sleep(700);
}

// The dashboard is recognised by its composer: the counts line scrolls with the list, so it is
// off screen whenever the list is scrolled down.
async function toDashboard() {
  for (let i = 0; i < 3 && !A.find(A.byId("dashboard-composer")); i++) await back();
  await A.waitNode(A.byId("dashboard-composer"), 20_000, "dashboard");
}

async function typeInto(id, text) {
  await A.tap(A.byId(id), id);
  A.typeText(text);
  await sleep(500);
}

/** A saved host's row, by its label (the row's accessibility label is "label, user@host:port"). */
const hostRow = (label) => (n) => n.id.startsWith("host-row-") && n.desc.startsWith(`${label}, `);

async function hostIdOf(label) {
  const row = await A.waitNode(hostRow(label), 15_000, `host ${label}`);
  return row.id.slice("host-row-".length);
}

function deleteChars(n) {
  A.adb("shell", "input", "keyevent", ...Array.from({ length: n }, () => String(A.KEY.DEL)));
}

async function scrollUntil(pred, label, { from = [540, 1800], to = [540, 800], tries = 8 } = {}) {
  for (let i = 0; i < tries; i++) {
    const node = A.find(pred);
    if (node) return node;
    A.swipe(from[0], from[1], to[0], to[1], 400);
    await sleep(900);
  }
  return A.waitNode(pred, 3000, label);
}

/** Scrolls an open sheet until node `id` is fully visible above the footer holding `footerId`. */
async function revealAboveFooter(id, footerId, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const nodes = A.dump();
    const node = nodes.find(A.byId(id));
    const footer = nodes.find(A.byId(footerId));
    // The footer's 12dp padding sits above its button (~32px at 2.625x).
    if (node && footer && node.bounds[3] <= footer.bounds[1] - 40) return node;
    // Start above the form's multiline key field: a drag that begins on it scrolls the field.
    A.swipe(540, 1100, 540, 500, 400);
    await sleep(900);
  }
  throw new Error(`${id} never cleared the sheet footer`);
}

/** Polls uiautomator dumps until `pred(nodes)` holds. */
async function waitDump(pred, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const nodes = A.dump();
    if (pred(nodes)) return nodes;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const nodeHeight = (node) => (node ? node.bounds[3] - node.bounds[1] : 0);

/** Top/bottom of the host form's landmarks that are on screen (clipped by the sheet's viewport). */
function sheetLandmarks() {
  const nodes = A.dump();
  const out = {};
  for (const id of ["host-auth", "host-field-private-key", "host-field-passphrase"]) {
    const node = nodes.find(A.byId(id));
    if (node) out[id] = [node.bounds[1], node.bounds[3]];
  }
  return out;
}

const landmarksMoved = (a, b) =>
  Object.keys(a).some(
    (id) => !b[id] || Math.abs(a[id][0] - b[id][0]) >= 100 || Math.abs(a[id][1] - b[id][1]) >= 100,
  );

/**
 * Drags from a point on the multiline private-key field and asserts the sheet's content moved.
 * Up first (scrolls the content down); if the sheet already sat at its end, down.
 */
async function dragOnKeyField(label) {
  for (const dy of [-500, 500]) {
    const field = await A.waitNode(A.byId("host-field-private-key"), 5000, "key field");
    const [x] = A.center(field);
    const y = Math.round(field.bounds[1] + Math.min(120, (field.bounds[3] - field.bounds[1]) / 2));
    const before = sheetLandmarks();
    A.swipe(x, y, x, Math.min(2250, Math.max(150, y + dy)), 500);
    await sleep(1200);
    const after = sheetLandmarks();
    if (landmarksMoved(before, after))
      return `${label}: drag from (${x},${y}) by ${dy}px moved the sheet ${JSON.stringify(before)} → ${JSON.stringify(after)}`;
  }
  throw new Error(`${label}: a drag that starts on the key field did not scroll the sheet`);
}

/** Label, host, port and user in the open host form sheet. */
async function fillAddress(label, port) {
  await typeInto("host-field-label", label);
  await typeInto("host-field-host", "10.0.2.2");
  await A.tap(A.byId("host-field-port"), "port");
  A.key(A.KEY.MOVE_END);
  deleteChars(6);
  A.typeText(String(port));
  await typeInto("host-field-username", os.userInfo().username);
  A.hideKeyboard();
  await sleep(500);
}

/** Android's 48dp floor with 1px of rounding (bounds are whole pixels: 48dp = 126px at 2.625x). */
const MIN_TARGET_DP = 47.5;
const round1 = (v) => Math.round(v * 10) / 10;
const inside = (inner, outer) =>
  inner.bounds[0] >= outer.bounds[0] &&
  inner.bounds[1] >= outer.bounds[1] &&
  inner.bounds[2] <= outer.bounds[2] &&
  inner.bounds[3] <= outer.bounds[3];

/** The spoken name: the node's own content-desc/text, else its descendants' text. */
function spokenName(node, nodes) {
  if (node.desc || node.text) return node.desc || node.text;
  return nodes
    .filter((n) => n !== node && n.text && inside(n, node))
    .map((n) => n.text)
    .join(" ");
}

/**
 * Asserts each control is on screen, has a spoken name and a ≥44dp hit area (bounds + hitSlop on
 * each side), and records it. controls: [label, predicate, { slop, optional, selected, textOnly }].
 */
function auditControls(ctx, screen, controls) {
  const nodes = A.dump();
  for (const [label, pred, opts = {}] of controls) {
    const node = nodes.find(pred);
    if (!node) {
      if (opts.optional) continue;
      const named = nodes.filter((n) => n.desc).map((n) => `${n.cls}:${n.desc}`);
      throw new Error(`a11y ${screen}: ${label} not found (labelled: ${named.join(" | ")})`);
    }
    const [x1, y1, x2, y2] = node.bounds;
    const slop = opts.slop ?? 0;
    const w = (x2 - x1) / ctx.dp + slop * 2;
    const h = (y2 - y1) / ctx.dp + slop * 2;
    const name = spokenName(node, nodes);
    ctx.audit.push({
      screen,
      control: label,
      id: node.id,
      cls: node.cls,
      name,
      wDp: round1(w),
      hDp: round1(h),
      slopDp: slop,
      selected: node.selected,
      enabled: node.enabled,
    });
    assert(name, `a11y ${screen}: ${label} has no label`);
    // A heading (the sheet title) is announced, not tapped: label only.
    assert(
      opts.textOnly || Math.min(w, h) >= MIN_TARGET_DP,
      `a11y ${screen}: ${label} hit area ${round1(w)}x${round1(h)}dp < 48dp`,
    );
    if (opts.selected !== undefined)
      assert(node.selected === opts.selected, `a11y ${screen}: ${label} selected=${node.selected}`);
  }
  sweepClickables(ctx, screen, nodes);
}

/** Every other clickable node of the app on screen: recorded when unnamed or under 44dp. */
function sweepClickables(ctx, screen, nodes) {
  for (const node of nodes) {
    if (!(node.clickable || node.longClickable) || node.pkg !== PKG) continue;
    const [x1, y1, x2, y2] = node.bounds;
    const w = (x2 - x1) / ctx.dp;
    const h = (y2 - y1) / ctx.dp;
    const name = spokenName(node, nodes);
    if (name && Math.min(w, h) >= MIN_TARGET_DP) continue;
    // A node cut by a scrolling ancestor's edge (half scrolled out) reports its visible part only:
    // recorded as clipped, not as a small target.
    const clipped = nodes.some(
      (s) =>
        s.scrollable &&
        s !== node &&
        inside(node, s) &&
        (node.bounds[1] === s.bounds[1] || node.bounds[3] === s.bounds[3]),
    );
    ctx.sweep.push({
      screen,
      id: node.id,
      cls: node.cls,
      name,
      wDp: round1(w),
      hDp: round1(h),
      ...(clipped || h <= 0 ? { clipped: true } : {}),
    });
  }
}

/**
 * Closes the soft keyboard and checks the app stayed on the session (Back must only close the
 * keyboard). Waits for the keyboard to settle first: a Back sent while it is still animating can
 * reach the app instead of the IME.
 */
async function safeHideKeyboard() {
  await sleep(700);
  if (!A.keyboardShown()) return;
  A.key(A.KEY.BACK);
  await sleep(800);
  const nodes = A.dump();
  assert(
    nodes.some((n) => ["chat-list", "chat-composer", "prompt-panel"].includes(n.id)),
    "Back to close the keyboard left the session",
  );
}

/** Scrolls the answer panel's body until `pred`'s node is fully inside it; returns the node. */
async function revealInPanel(pred, label, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const nodes = A.dump();
    const node = nodes.find(pred);
    const box = nodes.find(A.byId("answer-scroll"));
    // A node scrolled out of the viewport reports clipped (even inverted) bounds: require a
    // positive, whole height inside the scroll box.
    const visible =
      node &&
      box &&
      node.bounds[3] - node.bounds[1] >= 40 &&
      node.bounds[1] >= box.bounds[1] &&
      node.bounds[3] <= box.bounds[3] + 1;
    if (visible) return node;
    if (!box) throw new Error(`no answer panel while looking for ${label}`);
    const x = Math.round((box.bounds[0] + box.bounds[2]) / 2);
    const h = box.bounds[3] - box.bounds[1];
    A.swipe(x, box.bounds[1] + Math.round(h * 0.8), x, box.bounds[1] + Math.round(h * 0.3), 400);
    await sleep(800);
  }
  throw new Error(`${label} never came into the answer panel`);
}

const byDesc = (desc) => (n) => n.desc === desc && n.clickable;

/** Back to the Hosts list (relaunching the activity if a back press left the app). */
async function toHosts() {
  for (let i = 0; i < 4 && !A.find(A.byId("hosts-list")); i++) {
    if (A.find(A.byId("hosts-add"))) break;
    await back();
  }
  if (!A.find(A.byId("hosts-add"))) {
    A.adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
    await sleep(2500);
  }
  await A.waitNode(A.byId("hosts-list"), 20_000, "hosts list");
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

function steps(ctx) {
  // --theme light: the run's base appearance is light, so every "-dark" shot is a light one.
  const shot = (name) =>
    A.screenshot(ctx.screens, ctx.light ? name.replace(/-dark$/, "-light") : name);
  const night = (on) => A.nightMode(ctx.light ? false : on);
  return [
    [
      "Fresh launch shows the Hosts empty state",
      async () => {
        await A.waitNode(A.byId("hosts-empty"), 30_000, "hosts empty");
        // v15 item 8: the empty state's Add host is the only way in; no header + over it.
        assert(!A.find(A.byId("hosts-add")), "the header + is shown over the empty hosts list");
        assert(A.find(A.byId("hosts-add-empty")), "the empty state has no Add host");
        shot("01-hosts-empty-dark");
      },
    ],
    [
      "Add host → generated key → save",
      async () => {
        await A.tap(A.byId("hosts-add-empty"), "add host");
        const key = await A.waitNode(A.byId("host-public-key"), 20_000, "generated key");
        assert(/^ssh-ed25519 AAAA\S+ pi-mobile$/.test(key.text), `bad public key: ${key.text}`);
        shot("02-add-host-sheet-dark");
        auditControls(ctx, "add-host sheet", [
          ["sheet title (dialog)", (n) => n.desc.endsWith(", dialog"), { textOnly: true }],
          ["Close", byDesc("Close")],
          ["Generate key", A.byId("host-auth-generate"), { selected: true }],
          ["Paste key", A.byId("host-auth-paste"), { selected: false }],
          ["Password", A.byId("host-auth-password")],
          ["Copy public key", A.byId("host-copy-public-key")],
          ["Name field", A.byId("host-field-label")],
          ["Host field", A.byId("host-field-host")],
          ["Port field", A.byId("host-field-port")],
          ["Username field", A.byId("host-field-username")],
          ["Cancel", A.byId("host-form-cancel")],
          ["Save", A.byId("host-save")],
        ]);
        await typeInto("host-field-label", "Sandbox");
        await typeInto("host-field-host", "10.0.2.2");
        await A.tap(A.byId("host-field-port"), "port");
        A.key(A.KEY.DEL);
        A.key(A.KEY.DEL);
        A.typeText(String(E.PORT));
        await typeInto("host-field-username", os.userInfo().username);
        A.hideKeyboard();
        E.authorize(key.text);
        shot("03-add-host-filled-dark");
        await A.tap(A.byId("host-save"), "save");
        await A.waitNode(A.idPrefix("host-row-"), 15_000, "host row");
        shot("04-hosts-list-dark");
        auditControls(ctx, "hosts", [
          ["Add host (+)", A.byId("hosts-add")],
          ["host row", A.idPrefix("host-row-")],
          ["edit pencil", A.idPrefix("host-edit-")],
        ]);
      },
    ],
    [
      "Connect → trust-host-key sheet → dashboard sections and counts",
      async () => {
        await A.tap(A.idPrefix("host-row-"), "host row");
        await A.waitNode(A.byId("host-key-sheet"), 40_000, "trust sheet");
        const digest = E.readState().hostFingerprint.replace(/^SHA256:/, "");
        const sheet = A.dump();
        assert(sheet.some(A.byText(digest)), "trust sheet does not show the sandbox host key");
        assert(sheet.some(A.byText(/^ED25519 · SHA256$/)), "trust sheet key label is not ED25519");
        assert(
          sheet.some(A.byText(/ssh-keygen -lf \/etc\/ssh\/ssh_host_ed25519_key\.pub/)),
          "trust sheet hint does not name the ed25519 host key file",
        );
        shot("05-trust-host-key-dark");
        auditControls(ctx, "trust sheet", [
          ["sheet title (dialog)", (n) => n.desc.endsWith(", dialog"), { textOnly: true }],
          ["Close", byDesc("Close")],
          ["Cancel", A.byId("host-key-cancel")],
          ["Trust and connect", A.byId("host-key-trust")],
        ]);
        await A.tap(A.byId("host-key-trust"), "trust");
        const summary = await A.waitNode(A.byId("dashboard-summary"), 45_000, "dashboard");
        await sleep(2500);
        const text = A.find(A.byId("dashboard-summary")).text || summary.text;
        assert(text === ctx.expectedSummary, `summary "${text}" != "${ctx.expectedSummary}"`);
        const nodes = A.dump();
        const y = (pred) => nodes.find(pred)?.bounds[1] ?? -1;
        const order = [
          y(A.byText("Needs input")),
          y(rowOf(sessionIdOf("waiting"))),
          y(A.byText("Working")),
          y(rowOf(sessionIdOf("working"))),
          y(A.byText("Completed")),
          y(rowOf(E.readState().richId)),
          y(rowOf(E.readState().endedId)),
        ];
        assert(
          order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])),
          `section order ${order}`,
        );
        shot("06-dashboard-dark");
        // Item 2: the model stays on every row, and the title gets the room (model and age keep
        // their natural width; the title is the part that truncates).
        for (const row of nodes.filter(A.idPrefix("session-row-"))) {
          const texts = nodes.filter((n) => n.text && inside(n, row));
          // The row's label starts with its title (the glyph is a text node of its own).
          const title = texts.find((n) => n.text.length > 1 && row.desc.startsWith(n.text));
          assert(
            texts.length >= 3,
            `row ${row.id} lacks title/model/age: ${texts.map((n) => n.text)}`,
          );
          assert(title, `row ${row.id}: no title node (label "${row.desc}")`);
          const rowW = row.bounds[2] - row.bounds[0];
          const titleW = title.bounds[2] - title.bounds[0];
          assert(titleW >= rowW * 0.45, `row ${row.id}: title ${titleW}px of ${rowW}px`);
        }
        auditControls(ctx, "dashboard", [
          ["Back", byDesc("Back")],
          ["session row", A.idPrefix("session-row-")],
          ["composer field", A.byId("dashboard-composer")],
          ["Send (disabled)", A.byId("dashboard-send")],
        ]);
        // State reads without colour or motion: every row's label names its state.
        const waitingDesc = nodes.find(rowOf(sessionIdOf("waiting")))?.desc ?? "";
        const workingDesc = nodes.find(rowOf(sessionIdOf("working")))?.desc ?? "";
        const closedDesc = nodes.find(rowOf(E.readState().endedId))?.desc ?? "";
        assert(/, needs input,/.test(waitingDesc), `waiting row label "${waitingDesc}"`);
        assert(/, working(,|$)/.test(workingDesc), `working row label "${workingDesc}"`);
        assert(/, closed(,|$)/.test(closedDesc), `closed row label "${closedDesc}"`);
        ctx.notes.push(`a11y: "${waitingDesc}" | "${workingDesc}" | "${closedDesc}"`);
        const unknown = nodes.find((n) => /\bUnknown\b/.test(n.text) || /\bUnknown\b/.test(n.desc));
        assert(!unknown, `dashboard says Unknown: "${unknown?.text || unknown?.desc}"`);
        // forge's row: glyph · title · model · age. No asking line, folder, status or error.
        const waitingRow = nodes.find(rowOf(sessionIdOf("waiting")));
        const rowTexts = nodes.filter((n) => n.text && inside(n, waitingRow)).map((n) => n.text);
        assert(rowTexts.length <= 4, `waiting row shows ${rowTexts.length} texts: ${rowTexts}`);
        assert(!nodes.some(A.byText(/^Allow bash/)), "dashboard shows what pi is asking");
        assert(!nodes.some(A.byText(/^asking:|^pi is asking/)), "dashboard shows an asking line");
        ctx.notes.push(`waiting row texts: ${rowTexts.join(" | ")}`);
      },
    ],
    [
      "Completed session: chat renders every item kind; tool detail sheet",
      async () => {
        await A.tap(rowOf(E.readState().richId), "rich row");
        await A.waitNode(A.byId("chat-list"), 30_000, "chat");
        await sleep(2500);
        shot("07-chat-completed-bottom-dark");
        await A.waitNode(A.byId("code-copy"), 10_000, "a code block's copy button");
        auditControls(ctx, "chat", [
          ["Back", byDesc("Back")],
          ["copy code", A.byId("code-copy")],
          ["composer field", A.byId("chat-composer")],
          ["Send", A.byId("chat-send")],
        ]);
        assert(!A.find(A.byId("session-tabs")), "the Chat | Terminal control is still shown");
        assert(A.find(A.byText("Fixed: login redirect loop")), "markdown heading missing");
        A.swipe(540, 900, 540, 1900, 400);
        await sleep(1200);
        shot("08-chat-completed-mid-dark");
        A.swipe(540, 900, 540, 1900, 400);
        await sleep(1200);
        shot("09-chat-completed-top-dark");
        // pi's transcript shows the message only: no time or copy row under a bubble.
        await A.waitNode(A.byId("user-message-bubble"), 10_000, "user bubble");
        for (const id of ["user-message-timestamp", "user-message-copy", "assistant-turn-copy"])
          assert(!A.find(A.byId(id)), `chat shows ${id}`);
        const nodes = A.dump();
        for (const label of ["Thinking", "Let me look at how sessions are checked."])
          assert(nodes.some(A.byText(label)), `missing ${label}`);
        {
          // v15 item 1: forge's compaction row (`✻ Compacted …`), not a hairline divider.
          const row = nodes.find(A.byId("chat-compaction"));
          assert(row && row.desc === "Compacted", `compaction row "${row?.desc}"`);
          assert(!nodes.some(A.byText(/Context compacted/)), "the old Context compacted divider");
          const listBox = nodes.find(A.byId("chat-list"));
          assert(
            listBox && row.bounds[3] - row.bounds[1] <= 160,
            `compaction row is ${row.bounds[3] - row.bounds[1]}px tall (one line expected)`,
          );
          ctx.notes.push(`compaction row: "${row.desc}" ${row.bounds}`);
        }
        for (const desc of [
          /^Shell, git log/,
          /^Search, redirect/,
          /^Read, src\/auth/,
          /^Edit, src\/auth\/sesion/,
        ])
          assert(nodes.some(A.byText(desc)), `missing tool ${desc}`);
        assert(nodes.some(A.byId("user-message")), "missing user message");
        // The tool row's accessible node is the full-size row (label + role on the pressable).
        auditControls(ctx, "chat (tool row)", [
          [
            "tool row (failed edit)",
            (n) => n.clickable && n.desc.startsWith("Edit, src/auth/sesion"),
          ],
        ]);
        await A.tap(A.byText("Edit, src/auth/sesion.ts"), "failed edit");
        await A.waitNode(A.byId("tool-call-sheet-close"), 10_000, "tool sheet");
        await sleep(1200);
        shot("10-tool-detail-failed-edit-dark");
        auditControls(ctx, "tool detail sheet", [["Close", A.byId("tool-call-sheet-close")]]);
        // The error leads the sheet: readable without scrolling past the diff.
        assert(A.find(A.byText(/ENOENT/)), "failed tool error not visible without scrolling");
        await A.tap(A.byId("tool-call-sheet-close"), "close sheet");
        await toDashboard();
      },
    ],
    [
      "Waiting session: answer pi's select dialog in the app (no composer, chat stays above)",
      async () => {
        const pid = windowPid("waiting");
        await A.tap(rowOf(sessionIdOf("waiting")), "waiting row");
        await A.waitNode(A.byId("prompt-panel"), 30_000, "prompt panel");
        await sleep(1500);
        const nodes = A.dump();
        const panel = nodes.find(A.byId("prompt-panel"));
        const list = nodes.find(A.byId("chat-list"));
        assert(
          nodes.some(A.byText(/terraform apply -auto-approve\?/)),
          "the dialog title is missing",
        );
        assert(list && list.bounds[3] <= panel.bounds[1] + 2, "the panel covers the chat");
        assert(
          !nodes.some(A.byId("chat-composer")),
          "the composer shows while pi's dialog is open",
        );
        assert(
          !nodes.some(A.byId("chat-waiting-banner")),
          "the passive banner shows over the dialog",
        );
        // forge draws no status line while a dialog holds the input's place (status-line.md).
        assert(!nodes.some(A.byId("session-state")), "the footer shows while pi's dialog is open");
        const terminal = nodes.find((n) => /terminal/i.test(n.text) || /terminal/i.test(n.desc));
        assert(!terminal, `the session mentions a terminal: "${terminal?.text || terminal?.desc}"`);
        for (const [i, label] of ["Allow", "Allow always", "Deny"].entries())
          assert(
            nodes.find(A.byId(`prompt-option-${i}`))?.desc === label,
            `option ${i} != ${label}`,
          );
        shot("80-prompt-select-dark");
        auditControls(ctx, "prompt (select)", [
          ["option Allow", A.byId("prompt-option-0")],
          ["option Deny", A.byId("prompt-option-2")],
          ["Cancel", A.byId("prompt-cancel")],
        ]);
        A.tapNode(nodes.find(A.byId("prompt-option-0")));
        await sleep(250);
        shot("81-prompt-sent-dark");
        const answered = await E.waitFor(
          () => E.events(pid).find((e) => e.action === "prompt.respond" && e.by === "app"),
          20_000,
          "prompt.respond from the app",
        );
        assert(
          answered.value === "Allow" && !answered.cancel,
          `answered ${JSON.stringify(answered)}`,
        );
        await A.waitGone(A.byId("prompt-panel"), 20_000, "panel to close");
        await A.waitNode(
          A.byText(/terraform apply -auto-approve\? → Allow/),
          20_000,
          "answer in chat",
        );
        await A.waitNode(A.byId("chat-composer"), 10_000, "composer back");
        shot("82-prompt-answered-chat-dark");
        ctx.notes.push(`select answered: ${JSON.stringify(answered)}`);
      },
    ],
    [
      "pi's confirm, input and editor dialogs answered in the app; a custom dialog stays calm",
      async () => {
        const pid = windowPid("waiting");
        const responds = () => E.events(pid).filter((e) => e.action === "prompt.respond");
        const nextRespond = async (n, label) => E.waitFor(() => responds()[n], 20_000, label);
        let n = responds().length;
        E.control(pid, {
          op: "prompt",
          kind: "confirm",
          title: "Overwrite README.md?",
          message: "It has changes that are not committed.",
        });
        await A.waitNode(A.byText("Overwrite README.md?"), 20_000, "confirm");
        await sleep(800);
        assert(A.find(A.byId("prompt-option-0"))?.desc === "Yes", "confirm has no Yes row");
        shot("83-prompt-confirm-dark");
        await A.tap(A.byId("prompt-option-1"), "No");
        let e = await nextRespond(n++, "confirm answer");
        assert(e.value === "No" && e.by === "app", `confirm ${JSON.stringify(e)}`);
        await A.waitGone(A.byId("prompt-panel"), 20_000, "confirm to close");

        E.control(pid, {
          op: "prompt",
          kind: "input",
          title: "Name the new branch",
          placeholder: "feature/…",
        });
        await A.waitNode(A.byId("prompt-input"), 20_000, "input");
        await typeInto("prompt-input", "fix/login-loop");
        A.hideKeyboard();
        await sleep(600);
        shot("84-prompt-input-dark");
        auditControls(ctx, "prompt (input)", [
          ["field", A.byId("prompt-input")],
          ["Cancel", A.byId("prompt-cancel")],
          ["Submit", A.byId("prompt-submit")],
        ]);
        await A.tap(A.byId("prompt-submit"), "Submit");
        e = await nextRespond(n++, "input answer");
        assert(e.value === "fix/login-loop", `input ${JSON.stringify(e)}`);
        await A.waitGone(A.byId("prompt-panel"), 20_000, "input to close");

        E.control(pid, {
          op: "prompt",
          kind: "editor",
          title: "Commit message",
          prefill:
            "fix: stop the login redirect loop\n\nThe session check ran before the cookie was set.",
        });
        const editor = await A.waitNode(A.byId("prompt-input"), 20_000, "editor");
        await sleep(800);
        assert(
          (A.find(A.byId("prompt-input"))?.text ?? editor.text).startsWith(
            "fix: stop the login redirect loop",
          ),
          "editor has no prefill",
        );
        shot("85-prompt-editor-dark");
        await A.tap(A.byId("prompt-cancel"), "Cancel");
        e = await nextRespond(n++, "editor cancel");
        assert(e.cancel === true, `editor ${JSON.stringify(e)}`);
        await A.waitGone(A.byId("prompt-panel"), 20_000, "editor to close");

        E.control(pid, { op: "prompt", kind: "custom", title: "MCP servers" });
        await A.waitNode(A.byId("prompt-on-computer"), 20_000, "custom dialog");
        await sleep(800);
        const nodes = A.dump();
        const panel = nodes.find(A.byId("prompt-panel"));
        const actions = nodes.filter((x) => x.clickable && inside(x, panel));
        assert(
          actions.length === 0,
          `custom dialog has actions: ${actions.map((x) => x.desc || x.id)}`,
        );
        assert(nodes.some(A.byText("MCP servers")), "custom dialog title missing");
        {
          // v15 item 2: forge refuses cancel on a custom dialog, so the panel has no action; it
          // must not block the chat: the list stays above it, most of the screen, scrollable.
          const list = nodes.find(A.byId("chat-list"));
          const [, sh] = A.screenSize();
          assert(list && panel, "chat list or panel missing with a custom dialog");
          assert(list.bounds[3] <= panel.bounds[1] + 2, "the custom panel covers the chat list");
          assert(
            list.bounds[3] - list.bounds[1] >= sh * 0.45,
            `chat list only ${list.bounds[3] - list.bounds[1]}px tall under a custom dialog`,
          );
          assert(list.scrollable, "the chat list is not scrollable under a custom dialog");
          ctx.notes.push(`custom dialog: list ${list.bounds}, panel ${panel.bounds}`);
        }
        shot("86-prompt-custom-dark");
        E.control(pid, { op: "clear" });
        await A.waitGone(A.byId("prompt-panel"), 20_000, "custom to close");
      },
    ],
    [
      "forge's ask_user: a two-question item (single + multi select, free text) submitted whole",
      async () => {
        const pid = windowPid("waiting");
        E.control(pid, {
          op: "ask",
          blocking: true,
          items: [
            {
              question: "Which database should the cache use?",
              header: "Database",
              options: [
                { label: "Postgres", description: "The app's main database" },
                { label: "SQLite", description: "A file next to the service" },
              ],
            },
            {
              question: "Which checks should run before the deploy?",
              header: "Checks",
              multiSelect: true,
              options: [{ label: "lint" }, { label: "types" }, { label: "tests" }],
            },
          ],
        });
        await A.waitNode(A.byId("ask-panel"), 20_000, "ask panel");
        await sleep(1000);
        assert(!A.find(A.byId("chat-composer")), "composer shown while a blocking ask is open");
        shot("87-ask-item-dark");
        auditControls(ctx, "ask panel", [
          ["radio option", A.byId("ask-option-0-0")],
          ["Dismiss", A.byId("ask-dismiss")],
          ["Submit (disabled)", A.byId("ask-submit")],
        ]);
        A.tapNode(await revealInPanel(A.byId("ask-option-0-1"), "SQLite"));
        await sleep(400);
        A.tapNode(await revealInPanel(A.byId("ask-option-1-0"), "lint"));
        await sleep(400);
        A.tapNode(await revealInPanel(A.byId("ask-option-1-2"), "tests"));
        await sleep(400);
        A.tapNode(await revealInPanel(A.byId("ask-typed-1"), "own answer"));
        await sleep(800);
        A.typeText("and e2e");
        await safeHideKeyboard();
        const lint = await revealInPanel(A.byId("ask-option-1-0"), "lint (checked)");
        assert(lint.checked, "lint is not checked");
        assert(!A.find(A.byId("ask-option-1-1"))?.checked, "types is checked");
        shot("88-ask-filled-dark");
        await A.tap(A.byId("ask-submit"), "Submit");
        const answered = await E.waitFor(
          () => E.events(pid).find((e) => e.action === "ask.answer" && e.by === "app"),
          20_000,
          "ask.answer",
        );
        const want = [{ picked: ["SQLite"] }, { picked: ["lint", "tests"], typed: "and e2e" }];
        assert(
          JSON.stringify(answered.answers) === JSON.stringify(want),
          `answers ${JSON.stringify(answered.answers)}`,
        );
        await A.waitGone(A.byId("ask-panel"), 20_000, "ask panel to close");
        await A.waitNode(
          A.byText(/Which checks should run before the deploy\? → lint, tests, and e2e/),
          20_000,
          "answers in chat",
        );
        shot("89-ask-answered-dark");
        ctx.notes.push(`ask answered: ${JSON.stringify(answered.answers)}`);
      },
    ],
    [
      "The desktop answered first: the app's answer is stale and says so calmly",
      async () => {
        const pid = windowPid("waiting");
        E.control(pid, [
          { op: "desktop-first", count: 1 },
          { op: "prompt", kind: "select", title: "Allow bash: rm -rf node_modules?" },
        ]);
        await A.waitNode(A.byText("Allow bash: rm -rf node_modules?"), 20_000, "dialog");
        await sleep(600);
        await A.tap(A.byId("prompt-option-2"), "Deny");
        await A.waitNode(A.byId("answer-stale"), 20_000, "stale notice");
        // Read the notice at once, from the same dump as its bounds: the layout moves when the
        // panel closes, and the notice dismisses itself after a few seconds.
        const fresh = A.dump();
        const stale = fresh.find(A.byId("answer-stale"));
        const text = fresh
          .filter((x) => x.text && stale && inside(x, stale))
          .map((x) => x.text)
          .join(" ");
        assert(/Already answered on your computer/.test(text), `stale text "${text}"`);
        shot("90-answer-stale-dark");
        await A.waitGone(A.byId("prompt-panel"), 20_000, "dialog to close");
        const last = E.events(pid).findLast((e) => e.action === "prompt.respond");
        assert(
          last.by === "desktop" && last.value === "Allow",
          `last answer ${JSON.stringify(last)}`,
        );
        ctx.notes.push(`stale: "${text}"; desktop answered ${last.value}`);
      },
    ],
    [
      "The / menu: forge's rows, filtered as typed; a row completes; command.run; /tasks opens natively",
      async () => {
        const pid = windowPid("waiting");
        await A.waitNode(A.byId("chat-composer"), 20_000, "composer");
        await typeInto("chat-composer", "/");
        await A.waitNode(A.byId("slash-menu"), 10_000, "slash menu");
        await sleep(600);
        assert(A.find(A.byId("slash-row-answer")), "menu misses forge's first row");
        shot("91-slash-menu-dark");
        auditControls(ctx, "slash menu", [["row /answer", A.byId("slash-row-answer")]]);
        A.typeText("co");
        await sleep(900);
        const filtered = A.dump();
        assert(filtered.some(A.byId("slash-row-compact")), "/co hides compact");
        assert(!filtered.some(A.byId("slash-row-model")), "/co still lists model");
        shot("92-slash-filtered-dark");
        await A.tap(A.byId("slash-row-compact"), "/compact");
        await sleep(600);
        const field = A.find(A.byId("chat-composer"))?.text ?? "";
        assert(field === "/compact ", `composer after the tap: "${field}"`);
        assert(!A.find(A.byId("slash-menu")), "menu still open after completing");
        A.typeText("keep the plan");
        A.hideKeyboard();
        await sleep(500);
        await A.tap(A.byId("chat-send"), "send");
        const ran = await E.waitFor(
          () => E.events(pid).find((e) => e.action === "command.run"),
          20_000,
          "command.run",
        );
        assert(ran.line === "/compact keep the plan", `ran ${ran.line}`);
        await sleep(1500);
        // v14 item 2/3: the app adds no "Ran …" line of its own (forge prints none).
        assert(!A.find(A.byText(/^Ran \//)), "an app-made 'Ran /…' line in the chat");
        shot("93-command-ran-dark");
        await typeInto("chat-composer", "/tasks");
        A.hideKeyboard();
        await sleep(500);
        await A.tap(A.byId("chat-send"), "send /tasks");
        // The CLI's name for a forge view opens its native screen (never command.run, never pasted).
        await A.waitNode(A.byId("tasks-list"), 20_000, "native /tasks screen");
        shot("94-command-native-tasks-dark");
        assert(!A.find(A.byId("chat-send-error")), "a send error for /tasks");
        assert(
          !E.events(pid).some((e) => e.action === "command.run" && e.line === "/tasks"),
          "/tasks went through command.run",
        );
        await back();
        await A.waitNode(A.byId("chat-composer"), 20_000, "back on the chat");
        const submits = E.events(pid).filter(
          (e) => e.kind === "submit" && (e.text ?? "").startsWith("/"),
        );
        assert(submits.length === 0, `a / line was pasted: ${submits.map((s) => s.text)}`);
        await toDashboard();
      },
    ],
    ...forgeSteps(ctx, { shot, auditControls, toDashboard, scrollUntil }),
    [
      "Landscape: dashboard, chat and the add-host sheet fit the rotated screen",
      async () => {
        A.rotate(1);
        await sleep(2500);
        await A.waitNode(A.byId("dashboard-summary"), 15_000, "dashboard (landscape)");
        const short = Math.min(...A.screenSize());
        shot("34-dashboard-landscape-dark");
        const composer = await A.waitNode(A.byId("dashboard-composer"), 10_000, "composer");
        assert(composer.bounds[3] <= short, `dashboard composer off screen ${composer.bounds}`);
        // Swipe inside the list band: start just above the composer (its height is the touch floor).
        const listBottom = composer.bounds[1] - 40;
        const landscapeScroll = {
          from: [1200, listBottom],
          to: [1200, Math.max(300, listBottom - 450)],
        };
        const row = await scrollUntil(rowOf(E.readState().richId), "rich row", landscapeScroll);
        A.tapNode(row);
        await A.waitNode(A.byId("chat-list"), 30_000, "chat (landscape)");
        await sleep(2500);
        shot("35-chat-landscape-dark");
        const chatComposer = await A.waitNode(A.byId("chat-composer"), 10_000, "chat composer");
        assert(chatComposer.bounds[3] <= short, `chat composer off screen ${chatComposer.bounds}`);
        await toDashboard();
        await back();
        await A.tap(A.byId("hosts-add"), "add host (landscape)");
        // In landscape the generated key sits below the sheet's fold; the first field shows.
        await A.waitNode(A.byId("host-field-label"), 20_000, "host form (landscape)");
        await sleep(1200);
        shot("36-add-host-landscape-dark");
        const save = A.find(A.byId("host-save"));
        assert(save && save.bounds[3] <= short, "host form Save is off screen in landscape");
        A.hideKeyboard();
        await back();
        await A.waitGone(A.byId("host-field-label"), 10_000, "host form to close");
        A.rotate(0);
        await sleep(2000);
        await A.tap(hostRow("Sandbox"), "Sandbox");
        await A.waitNode(A.byId("dashboard-summary"), 30_000, "dashboard");
      },
    ],
    [
      "Real pi + forge: its chat opens with pi's state and model (PIM_E2E_REAL_PI=1)",
      async () => {
        if (!E.readState().windows.real) {
          ctx.notes.push("real pi: skipped (PIM_E2E_REAL_PI unset)");
          return;
        }
        const row = await scrollUntil(rowOf(realSessionId()), "real pi row");
        A.tapNode(row);
        await A.waitNode(A.byId("chat-composer"), 30_000, "real pi chat");
        await sleep(3000);
        shot("32-chat-real-pi-dark");
        const realState = A.find(A.byId("session-state"))?.text ?? "";
        assert(!/Unknown/.test(realState), `real pi sub-bar says Unknown: "${realState}"`);
        ctx.notes.push(`real pi sub-bar: "${realState}"`);
        // forge's remote channel (worktree): run the rig from the / menu, answer its dialogs.
        await typeInto("chat-composer", "/pim");
        await A.waitNode(A.byId("slash-row-pimrig"), 30_000, "forge's /pimrig row");
        await A.tap(A.byId("slash-row-pimrig"), "/pimrig");
        await sleep(400);
        await safeHideKeyboard();
        await A.tap(A.byId("chat-send"), "send /pimrig");
        await A.waitNode(A.byText("RIG pick a color"), 30_000, "real forge select");
        await sleep(1000);
        assert(!A.find(A.byId("chat-composer")), "composer shown over forge's dialog");
        shot("95-real-forge-select-dark");
        const green = A.dump().find((n) => n.id.startsWith("prompt-option-") && n.desc === "green");
        assert(green, "no green option in forge's select");
        A.tapNode(green);
        await E.waitFor(() => E.rigLog().includes("picked=green"), 20_000, "rig picked green");
        await A.waitNode(A.byText("RIG name it"), 20_000, "real forge input");
        await typeInto("prompt-input", "from the phone");
        await safeHideKeyboard();
        shot("96-real-forge-input-dark");
        await A.tap(A.byId("prompt-submit"), "Submit");
        await E.waitFor(
          () => E.rigLog().includes("input=from the phone"),
          20_000,
          "rig input from the phone",
        );
        await A.waitGone(A.byId("prompt-panel"), 20_000, "forge dialog to close");
        await A.waitNode(A.byId("chat-composer"), 20_000, "composer back");
        ctx.notes.push(`real forge rig: ${E.rigLog().join(" | ")}`);
        await toDashboard();
      },
    ],
    ...realForgeSteps(ctx, { shot, auditControls, toDashboard, scrollUntil }),
    [
      "Send a prompt from Chat to an idle session (bracketed paste + Enter)",
      async () => {
        const n = eventCount("idle");
        await A.tap(rowOf(sessionIdOf("idle")), "idle row");
        await typeInto("chat-composer", "Add a fourth bullet about tests");
        shot("16-chat-composer-typing-dark");
        await A.tap(A.byId("chat-send"), "send");
        shot("17-chat-sent-optimistic-dark");
        {
          // The footer is forge's line only: never a state word (Idle, Sending…, Working).
          const sent = A.dump();
          const stateText = sent.find(A.byId("session-state"))?.text ?? "";
          assert(
            !/^(Idle|Sending|Working|Needs input)\b/.test(stateText),
            `footer starts with a state word: "${stateText}"`,
          );
          ctx.notes.push(`footer right after send: "${stateText}"`);
        }
        A.hideKeyboard();
        await A.waitNode(A.byText(/^echo: Add a fourth/), 20_000, "reply");
        shot("18-chat-reply-dark");
        const ev = eventsSince("idle", n);
        const submit = ev.find((e) => e.kind === "submit");
        assert(
          submit?.text === "Add a fourth bullet about tests" && submit.pasted,
          "no pasted submit",
        );
        assert(inputHex("idle", n).join("").startsWith("1b5b3230307e"), "not a bracketed paste");
        await toDashboard();
      },
    ],
    [
      "Stop on a working session sends exactly one Escape",
      async () => {
        const n = eventCount("working");
        await A.tap(rowOf(sessionIdOf("working")), "working row");
        const stop = await A.waitNode(A.byId("chat-stop"), 30_000, "stop button");
        {
          // pi's working row above the composer (look.md), not a word in the footer.
          const working = await A.waitNode(A.byId("chat-working"), 15_000, "working row");
          assert(
            /^pi is working, \d+(s|m)/.test(working.desc),
            `working row label "${working.desc}"`,
          );
          const nodes = A.dump();
          const composer = nodes.find(A.byId("chat-composer"));
          assert(
            composer && working.bounds[3] <= composer.bounds[1] + 2,
            "the working row is not above the composer",
          );
          const foot = nodes.find(A.byId("session-state"))?.text ?? "";
          assert(!/Working|Idle|Needs input/.test(foot), `footer has a state word: "${foot}"`);
          ctx.notes.push(`working row: "${working.desc}"; footer "${foot}"`);
        }
        shot("19-chat-working-stop-dark");
        auditControls(ctx, "chat (working)", [["Stop", A.byId("chat-stop")]]);
        A.tapNode(stop);
        await sleep(250);
        A.tapNode(stop);
        await sleep(3000);
        shot("20-chat-after-stop-dark");
        const escapes = eventsSince("working", n).filter((e) => e.kind === "escape");
        assert(escapes.length === 1, `${escapes.length} Escapes delivered`);
        assert(E.procState(windowPid("working")) === "idle", "still working");
        await toDashboard();
      },
    ],
    [
      "Closed session → Resume and send",
      async () => {
        const { endedId } = E.readState();
        await A.tap(rowOf(endedId), "closed row");
        await A.waitNode(A.byId("chat-composer"), 30_000, "composer");
        {
          // v14 item 3: no app-made sentences (pi shows neither).
          await sleep(1500);
          const nodes = A.dump();
          assert(!nodes.some(A.byText(/Sending reopens this session/)), "closed hint is back");
          assert(!nodes.some(A.byText(/Earlier messages are not loaded/)), "earlier-messages note");
        }
        shot("21-chat-closed-dark");
        await typeInto("chat-composer", "Also mention the migration guide");
        await A.tap(A.byId("chat-send"), "send");
        A.hideKeyboard();
        await A.waitNode(A.byText(/^echo: Also mention/), 45_000, "resumed reply");
        shot("22-chat-resumed-reply-dark");
        assert(!fs.existsSync(path.join(E.PROCS, "ended", `${endedId}.json`)), "ended record kept");
        assert(!A.find(A.byId("chat-send-error")), "send error shown");
        await toDashboard();
      },
    ],
    [
      "Dashboard composer starts a session and navigates into it",
      async () => {
        const windows = E.tmux("list-windows", "-t", "pi", "-F", "#{window_name}");
        await typeInto("dashboard-composer", "Write release notes for v3");
        shot("23-dashboard-composer-dark");
        await A.tap(A.byId("dashboard-send"), "send");
        A.hideKeyboard();
        await A.waitNode(A.byId("chat-list"), 40_000, "new session chat");
        await A.waitNode(A.byText(/^echo: Write release notes/), 20_000, "new session reply");
        shot("24-new-session-chat-dark");
        const now = E.tmux("list-windows", "-t", "pi", "-F", "#{window_name}");
        assert(
          !windows.includes("Write-release-notes") && now.includes("Write-release-notes"),
          "no new window",
        );
      },
    ],
    [
      "sshd killed mid-session → reconnect banner → recovers",
      async () => {
        await E.sshdStop();
        await A.waitNode(A.byId("connection-banner"), 90_000, "reconnect banner");
        await sleep(1000);
        // The banner says it once; the sub-bar keeps the identity only (no stale "Idle", no repeat).
        const down = A.dump();
        const sub = down.find(A.byId("session-state"))?.text ?? "";
        assert(
          !/Reconnecting|Connecting|Not connected|Idle|Working|Needs input/.test(sub),
          `sub-bar repeats a state while the banner is up: "${sub}"`,
        );
        const saying = down.filter((n) => /Reconnecting…/.test(n.text));
        assert(saying.length <= 1, `"Reconnecting…" shown ${saying.length} times`);
        ctx.notes.push(`sub-bar while disconnected: "${sub}"; banner text nodes: ${saying.length}`);
        shot("25-reconnecting-banner-dark");
        auditControls(ctx, "reconnecting banner", [["Retry", A.byId("connection-retry")]]);
        await E.sshdStart();
        await A.waitGone(A.byId("connection-banner"), 90_000, "banner to clear");
        shot("26-recovered-dark");
      },
    ],
    [
      "Changed host key → refusal sheet → Replace pinned key",
      async () => {
        await toDashboard();
        await back();
        await A.waitNode(A.idPrefix("host-row-"), 20_000, "hosts");
        await E.hostkeyRotate();
        await sleep(1500);
        await A.tap(A.idPrefix("host-row-"), "host row");
        await A.waitNode(A.byId("host-key-mismatch-sheet"), 60_000, "mismatch sheet");
        const digest = E.readState().hostFingerprint.replace(/^SHA256:/, "");
        assert(A.find(A.byText(digest)), "mismatch sheet does not show the presented key");
        assert(!A.find(A.byId("host-key-sheet")), "trust sheet shown for a mismatch");
        {
          const labels = A.dump();
          const pinnedLabel = labels.find(A.byId("host-key-pinned-label"))?.text;
          const presentedLabel = labels.find(A.byId("host-key-presented-label"))?.text;
          assert(pinnedLabel === "Trusted · ED25519 · SHA256", `pinned label "${pinnedLabel}"`);
          assert(
            presentedLabel === "Presented now · ED25519 · SHA256",
            `presented label "${presentedLabel}"`,
          );
          ctx.notes.push(`mismatch labels: "${pinnedLabel}" | "${presentedLabel}"`);
        }
        shot("27-host-key-mismatch-dark");
        await A.tap(A.byId("host-key-replace"), "replace");
        await A.waitNode(A.byId("dashboard-summary"), 45_000, "dashboard after replace");
      },
    ],
    [
      "Completed overflow: Show N more reveals the older closed rows",
      async () => {
        const ids = E.seedClosed(7);
        const oldest = ids[ids.length - 1];
        await sleep(4000);
        const more = await scrollUntil(A.byText(/^Show \d+ more$/), "Show N more");
        shot("37-dashboard-show-more-dark");
        auditControls(ctx, "dashboard (overflow)", [
          ["Show N more", A.byId("dashboard-show-more")],
        ]);
        const hidden = Number(/\d+/.exec(more.text || more.desc)[0]);
        assert(hidden >= 2, `only ${hidden} closed rows hidden`);
        assert(!A.find(rowOf(oldest)), "oldest closed row shown before Show more");
        A.tapNode(more);
        await sleep(1500);
        assert(!A.find(A.byText(/^Show \d+ more$/)), "Show more still visible after tapping");
        await scrollUntil(rowOf(oldest), "oldest closed row");
        shot("38-dashboard-expanded-dark");
        ctx.notes.push(`show more: "Show ${hidden} more" revealed the oldest closed row`);
        for (let i = 0; i < 4; i++) A.swipe(540, 700, 540, 1900, 300);
        await sleep(1000);
      },
    ],
    [
      "Font scale 1.3 and 2.0: hosts, dashboard, chat and the add-host sheet keep their controls",
      async () => {
        const [W, H] = A.screenSize();
        const visible = (node) =>
          node &&
          node.bounds[2] > node.bounds[0] &&
          node.bounds[3] > node.bounds[1] &&
          node.bounds[2] <= W &&
          node.bounds[3] <= H;
        const scales = [
          [1.3, "13", 60],
          [2, "20", 64],
        ];
        await toHosts();
        const baseRow = A.find(hostRow("Sandbox"));
        let lastRowH = baseRow.bounds[3] - baseRow.bounds[1];
        try {
          for (const [scale, tag, n] of scales) {
            A.fontScale(scale);
            await sleep(3500);
            await toHosts();
            await sleep(1000);
            shot(`${n}-fs${tag}-hosts-dark`);
            // Text is re-measured at the new scale (a runtime change used to keep scale-1 bounds).
            const sandboxRow = A.find(hostRow("Sandbox"));
            const rowH = sandboxRow.bounds[3] - sandboxRow.bounds[1];
            assert(
              rowH > lastRowH,
              `host row ${rowH}px did not grow from ${lastRowH}px at ${scale}`,
            );
            ctx.notes.push(`font ${scale}: host row ${lastRowH} → ${rowH}px`);
            lastRowH = rowH;
            auditControls(ctx, `hosts @${scale}`, [
              ["Add host (+)", A.byId("hosts-add")],
              ["host row", hostRow("Sandbox")],
              ["edit pencil", A.idPrefix("host-edit-")],
            ]);
            await A.tap(hostRow("Sandbox"), "Sandbox");
            await A.waitNode(A.byId("dashboard-composer"), 45_000, `dashboard @${scale}`);
            await sleep(2500);
            shot(`${n + 1}-fs${tag}-dashboard-dark`);
            {
              // v14 item 4: at ≥1.3 every row is title (one line) over `model · age` (one line,
              // muted): the model stays on every row and nothing wraps.
              const dash = A.dump();
              // Lines of whole rows only: a row half under the composer reports clipped heights.
              const lines = [];
              for (const r of dash.filter(A.idPrefix("session-row-"))) {
                if (r.bounds[3] > H || r.bounds[1] < 0) continue;
                // A row cut by the list's edge (half under the composer) lists only its visible part.
                const cut = dash.some(
                  (sc) =>
                    sc.scrollable &&
                    inside(r, sc) &&
                    (r.bounds[1] === sc.bounds[1] || r.bounds[3] === sc.bounds[3]),
                );
                if (cut) continue;
                const title = dash.find((t) => t.id === "dashboard-row-title" && inside(t, r));
                const meta = dash.find((t) => t.id === "dashboard-row-meta" && inside(t, r));
                assert(title, `row ${r.id}: no title @${scale}`);
                assert(meta, `row ${r.id}: no model · age line @${scale}`);
                assert(
                  / · \d+[smhd]$|^\d+[smhd]$/.test(meta.text),
                  `row ${r.id} meta "${meta.text}"`,
                );
                assert(
                  meta.bounds[1] >= title.bounds[3] - 2,
                  `row ${r.id}: meta not under the title`,
                );
                const rowW = r.bounds[2] - r.bounds[0];
                const titleW = title.bounds[2] - title.bounds[0];
                assert(titleW >= rowW * 0.7, `row ${r.id}: title ${titleW}px of ${rowW}px`);
                lines.push(title, meta);
              }
              assert(lines.length >= 4, `only ${lines.length / 2} whole row(s) \u0040${scale}`);
              const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
              const lineH = (id) =>
                median(lines.filter((t) => t.id === id).map((t) => nodeHeight(t)));
              const titleH = lineH("dashboard-row-title");
              const metaH = lineH("dashboard-row-meta");
              const wrapped = lines.filter(
                (t) => nodeHeight(t) > (t.id === "dashboard-row-title" ? titleH : metaH) * 1.5,
              );
              assert(wrapped.length === 0, `${wrapped.length} row line(s) wrapped @${scale}`);
              ctx.notes.push(`font ${scale}: every row title / model · age, none wrapped`);
            }
            assert(
              visible(A.find(A.byId("dashboard-send"))),
              `dashboard send off screen @${scale}`,
            );
            const row = await scrollUntil(rowOf(E.readState().richId), "rich row");
            A.tapNode(row);
            await A.waitNode(A.byId("chat-list"), 30_000, `chat @${scale}`);
            await sleep(2500);
            shot(`${n + 2}-fs${tag}-chat-dark`);
            auditControls(ctx, `chat @${scale}`, [["Send", A.byId("chat-send")]]);
            const nodes = A.dump();
            const status = nodes.find(A.byId("session-state"));
            const composerBox = nodes.find(A.byId("chat-composer"));
            assert(visible(status), `footer clipped @${scale}`);
            assert(visible(composerBox), `composer off screen @${scale}`);
            assert(
              status.bounds[1] >= composerBox.bounds[3],
              `footer not under the composer @${scale}: ${status.bounds} vs ${composerBox.bounds}`,
            );
            ctx.notes.push(`font ${scale}: footer "${status.text}" ${status.bounds}`);
            const code = nodes.find(A.byId("code-block-scroll"));
            if (code) {
              assert(code.bounds[2] <= W, `code block wider than the screen @${scale}`);
              ctx.notes.push(`font ${scale}: code block scroll ${code.bounds}`);
            }
            {
              // v14 item 4: the model screen at a large font: chips whole, rows unclipped.
              await typeInto("chat-composer", "/model");
              A.hideKeyboard();
              await sleep(500);
              await A.tap(A.byId("chat-send"), "send /model");
              await A.waitNode(A.byId("model-list"), 20_000, `model @${scale}`);
              await sleep(1500);
              shot(`${tag === "13" ? 68 : 69}-fs${tag}-model-dark`);
              const model = A.dump();
              const chips = model.filter(
                (c) => c.id.startsWith("thinking-") && c.id !== "thinking-levels",
              );
              for (const chip of chips)
                assert(
                  chip.bounds[0] >= 0 && chip.bounds[2] <= W,
                  `thinking chip ${chip.id} clipped @${scale}: ${chip.bounds}`,
                );
              const tops = new Set(chips.map((c) => c.bounds[1]));
              ctx.notes.push(
                `font ${scale}: ${chips.length} thinking chips on ${tops.size} row(s)`,
              );
              await back();
              await A.waitNode(A.byId("chat-composer"), 20_000, `chat again @${scale}`);
            }
            await toDashboard();
            await back();
            await A.tap(A.byId("hosts-add"), `add host @${scale}`);
            await A.waitNode(A.byId("host-field-label"), 20_000, `host form @${scale}`);
            await sleep(1500);
            A.hideKeyboard();
            await sleep(600);
            shot(`${n + 3}-fs${tag}-add-host-dark`);
            {
              // v14 item 4: at ≥1.3 the three ways to sign in are stacked full-width 48dp rows.
              const form = A.dump();
              const pills = ["host-auth-generate", "host-auth-paste", "host-auth-password"].map(
                (id) => form.find(A.byId(id)),
              );
              for (const pill of pills) {
                assert(
                  pill && pill.bounds[0] >= 0 && pill.bounds[2] <= W - 20,
                  `auth choice ${pill?.id} clipped @${scale}: ${pill?.bounds}`,
                );
                assert(pill.bounds[2] - pill.bounds[0] >= W * 0.75, `${pill.id} not full width`);
                assert(nodeHeight(pill) >= 48 * (W / 411.43) - 2, `${pill.id} under 48dp`);
              }
              const rows = new Set(pills.map((p) => p.bounds[1])).size;
              assert(rows === 3, `auth choices on ${rows} row(s) @${scale}, want 3 stacked`);
              ctx.notes.push(`font ${scale}: auth choices stacked on ${rows} rows`);
            }
            auditControls(ctx, `add-host sheet @${scale}`, [
              ["Generate key", A.byId("host-auth-generate")],
              ["Paste key", A.byId("host-auth-paste")],
              ["Password", A.byId("host-auth-password")],
              ["Cancel", A.byId("host-form-cancel")],
              ["Save", A.byId("host-save")],
            ]);
            await back();
            await A.waitGone(A.byId("host-field-label"), 10_000, "host form to close");
          }
        } finally {
          A.fontScale(1);
        }
        await sleep(3500);
        await toHosts();
        await A.tap(hostRow("Sandbox"), "Sandbox");
        await A.waitNode(A.byId("dashboard-summary"), 45_000, "dashboard at font scale 1");
        await sleep(1500);
      },
    ],
    [
      "Font-scale reload keeps the place: same session, dashboard beneath it",
      async () => {
        await toDashboard();
        const row = await scrollUntil(rowOf(E.readState().richId), "rich row");
        const title = row.desc.split(", ")[0];
        A.tapNode(row);
        await A.waitNode(A.byId("chat-list"), 30_000, "chat");
        await sleep(2500);
        const stateH = nodeHeight(A.find(A.byId("session-state")));
        assert(stateH > 0, "no sub-bar state line");
        try {
          A.fontScale(1.3);
          // The reload is proven by the re-measured (taller) state line; the place by the same
          // session's title in the header.
          const restored = await waitDump(
            (nodes) =>
              nodes.some(A.byId("chat-list")) &&
              nodes.some((n) => n.text === title) &&
              nodeHeight(nodes.find(A.byId("session-state"))) > stateH + 4,
            60_000,
            "the same session after the font-scale reload",
          );
          const stateH13 = nodeHeight(restored.find(A.byId("session-state")));
          shot("72-fs13-restored-chat-dark");
          ctx.notes.push(
            `font 1.3 reload: "${title}" reopened (state line ${stateH} → ${stateH13}px)`,
          );
          A.fontScale(1);
          await waitDump(
            (nodes) =>
              nodes.some(A.byId("chat-list")) &&
              nodes.some((n) => n.text === title) &&
              nodeHeight(nodes.find(A.byId("session-state"))) < stateH13 - 4,
            60_000,
            "the same session after the reload back to 1.0",
          );
          await sleep(1500);
          shot("73-fs10-restored-chat-dark");
          ctx.notes.push("font 1.0 reload: the session reopened again");
        } finally {
          A.fontScale(1);
        }
        // The rebuilt stack: back leaves the session for its dashboard.
        await back();
        await A.waitNode(
          A.byId("dashboard-composer"),
          20_000,
          "dashboard under the restored session",
        );
        await sleep(1500);
      },
    ],
    [
      "Light mode: dashboard, chat, tool sheet, hosts",
      async () => {
        night(false);
        await sleep(3000);
        shot("28-dashboard-light");
        A.rotate(1);
        await sleep(2500);
        shot("53-dashboard-landscape-light");
        A.rotate(0);
        await sleep(2000);
        await A.tap(rowOf(E.readState().richId), "rich row");
        await A.waitNode(A.byId("chat-list"), 30_000, "chat");
        await sleep(2500);
        shot("29-chat-light");
        A.swipe(540, 900, 540, 1900, 400);
        await sleep(1200);
        A.swipe(540, 900, 540, 1900, 400);
        await sleep(1200);
        await A.tap(A.byText("Edit, src/auth/sesion.ts"), "failed edit");
        await A.waitNode(A.byId("tool-call-sheet-close"), 10_000, "tool sheet");
        await sleep(1200);
        shot("39-tool-detail-failed-edit-light");
        assert(A.find(A.byText(/ENOENT/)), "failed tool error not visible without scrolling");
        await A.tap(A.byId("tool-call-sheet-close"), "close sheet");
        await sleep(800);
        await toDashboard();
        await back();
        await A.waitNode(A.idPrefix("host-row-"), 20_000, "hosts");
        shot("31-hosts-list-light");
      },
    ],
    [
      "Password sign-in (password gateway) → trust sheet → dashboard, in the run's theme",
      async () => {
        // v14 item 11: in the run's own theme (dark run: dark, light run: light); switching the
        // theme while a sheet is open dismisses the sheet, so each run captures its own.
        night(true);
        await sleep(2500);
        const gw = await E.gatewayStart();
        await A.tap(A.byId("hosts-add"), "add host");
        await A.waitNode(A.byId("host-public-key"), 20_000, "add host sheet");
        await fillAddress("Gateway", gw.port);
        await A.tap(A.byId("host-auth-password"), "password mode");
        await typeInto("host-field-password", gw.password);
        A.hideKeyboard();
        await sleep(600);
        shot("40-add-host-password-dark");
        await A.tap(A.byId("host-save"), "save");
        await A.tap(hostRow("Gateway"), "Gateway row", 15_000);
        await A.waitNode(A.byId("host-key-sheet"), 40_000, "trust sheet");
        const digest = E.readState().hostFingerprint.replace(/^SHA256:/, "");
        assert(A.find(A.byText(digest)), "trust sheet does not show the gateway host key");
        shot("41-trust-host-key-dark");
        await A.tap(A.byId("host-key-trust"), "trust");
        await A.waitNode(A.byId("dashboard-summary"), 45_000, "dashboard over password auth");
        await sleep(2500);
        shot("42-dashboard-password-host-dark");
        const auth = fs
          .readFileSync(gw.logFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert(
          auth.some((e) => e.method === "password" && e.ok),
          `no accepted password auth: ${JSON.stringify(auth)}`,
        );
        ctx.notes.push(`password gateway auth attempts: ${JSON.stringify(auth)}`);
      },
    ],
    [
      "Changed host key in light mode → mismatch sheet → Replace",
      async () => {
        await toDashboard();
        await back();
        await A.waitNode(hostRow("Sandbox"), 20_000, "hosts");
        await E.hostkeyRestore();
        await sleep(1500);
        await A.tap(hostRow("Sandbox"), "Sandbox");
        await A.waitNode(A.byId("host-key-mismatch-sheet"), 60_000, "mismatch sheet");
        shot("43-host-key-mismatch-light");
        await A.tap(A.byId("host-key-replace"), "replace");
        await A.waitNode(A.byId("dashboard-summary"), 45_000, "dashboard after replace");
      },
    ],
    [
      "Paste-private-key sign-in → trust sheet → dashboard",
      async () => {
        night(true);
        await sleep(1500);
        await toDashboard();
        await back();
        const keyFile = path.join(E.ROOT, "pasted_ed25519");
        execFileSync("ssh-keygen", [
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-C",
          "pim-pasted",
          "-f",
          keyFile,
        ]);
        E.authorize(fs.readFileSync(`${keyFile}.pub`, "utf8"));
        const fp = execFileSync("ssh-keygen", ["-lf", `${keyFile}.pub`], {
          encoding: "utf8",
        }).split(/\s+/)[1];
        await A.tap(A.byId("hosts-add"), "add host");
        await A.waitNode(A.byId("host-public-key"), 20_000, "add host sheet");
        await fillAddress("Laptop", E.PORT);
        await A.tap(A.byId("host-auth-paste"), "paste mode");
        await A.tap(A.byId("host-field-private-key"), "private key field");
        const lines = fs.readFileSync(keyFile, "utf8").trim().split("\n");
        lines.forEach((line, i) => {
          if (i > 0) A.key(A.KEY.ENTER);
          A.typeText(line);
        });
        // A drag that starts on the multiline key field scrolls the sheet: with the keyboard up
        // (field focused) and after it is hidden.
        ctx.notes.push(await dragOnKeyField("key-field drag, keyboard up"));
        A.hideKeyboard();
        await sleep(800);
        shot("44-add-host-paste-dark");
        ctx.notes.push(await dragOnKeyField("key-field drag, keyboard hidden"));
        shot("70-key-field-after-drag-dark");
        // The field still takes a tap (keyboard), select-all, cut and paste.
        await A.tap(A.byId("host-field-private-key"), "key field after the drags");
        await sleep(1000);
        assert(
          /mInputShown=true/.test(A.adb("shell", "dumpsys", "input_method")),
          "tap on the key field did not open the keyboard",
        );
        const body = lines[1];
        const keyText = () => A.find(A.byId("host-field-private-key"))?.text ?? "";
        const combo = (...codes) =>
          A.adb("shell", "input", "keycombination", ...codes.map((c) => String(c)));
        combo(113, 29); // Ctrl+A
        await sleep(400);
        combo(113, 52); // Ctrl+X
        await sleep(800);
        assert(!keyText().includes(body), "cut left the key in the field");
        combo(113, 50); // Ctrl+V
        await sleep(1000);
        assert(keyText().includes(body), "paste did not put the key back");
        A.hideKeyboard();
        await sleep(800);
        shot("71-key-field-pasted-dark");
        ctx.notes.push("key field: tap opens the keyboard; select-all, cut and paste round-trip");
        await A.tap(A.byId("host-save"), "save");
        await A.tap(hostRow("Laptop"), "Laptop row", 15_000);
        await A.waitNode(A.byId("host-key-sheet"), 40_000, "trust sheet");
        await A.tap(A.byId("host-key-trust"), "trust");
        await A.waitNode(A.byId("dashboard-summary"), 45_000, "dashboard over the pasted key");
        const accepted = fs
          .readFileSync(path.join(E.SSHD_DIR, "sshd.log"), "utf8")
          .split("\n")
          .filter((line) => line.includes("Accepted publickey") && line.includes(fp));
        assert(accepted.length > 0, `sshd never accepted the pasted key ${fp}`);
        ctx.notes.push(`pasted key: ${accepted[0].replace(/^.*Accepted/, "Accepted")}`);
      },
    ],
    [
      "Edit host: rename keeps the id, saved key and pinned host key",
      async () => {
        await toDashboard();
        await back();
        const id = await hostIdOf("Laptop");
        await A.tap(A.byId(`host-edit-${id}`), "edit Laptop");
        await A.waitNode(A.byId("host-field-label"), 15_000, "edit sheet");
        await A.tap(A.byId("host-field-label"), "label");
        A.key(A.KEY.MOVE_END);
        deleteChars(12);
        A.typeText("Laptop renamed");
        A.hideKeyboard();
        await sleep(600);
        shot("45-edit-host-dark");
        await A.tap(A.byId("host-save"), "save");
        await A.waitNode(hostRow("Laptop renamed"), 15_000, "renamed row");
        assert(!A.find(hostRow("Laptop")), "old label still listed");
        assert((await hostIdOf("Laptop renamed")) === id, "rename changed the host id");
        shot("46-hosts-list-edited-dark");
        await A.tap(hostRow("Laptop renamed"), "renamed host");
        await A.waitNode(A.byId("dashboard-summary"), 45_000, "dashboard after rename");
        assert(!A.find(A.byId("host-key-sheet")), "rename dropped the pinned host key");
      },
    ],
    [
      "Delete every host → Hosts empty state, in the run's theme",
      async () => {
        night(true);
        await sleep(1500);
        await toDashboard();
        await back();
        const openDeleteSheet = async (label, first) => {
          const id = await hostIdOf(label);
          await A.tap(A.byId(`host-edit-${id}`), `edit ${label}`);
          await A.waitNode(A.byId("host-field-label"), 15_000, "edit sheet");
          if (first) {
            // Item 11: the Host field is a full 48dp target when it is not scrolled under the
            // header (the sweep's 40dp was the scrolled sheet clipping it).
            await sleep(600);
            auditControls(ctx, "edit-host sheet (top)", [
              ["Host field", A.byId("host-field-host")],
            ]);
          }
          // uiautomator lists the button even while it sits behind the sticky footer, so scroll
          // until it is clear of Cancel/Save, then tap where it is now.
          await revealAboveFooter("host-delete", "host-save");
          if (first) {
            shot("54-edit-host-delete-row-dark");
            auditControls(ctx, "edit-host sheet", [
              ["sheet title (dialog)", (n) => n.desc.endsWith(", dialog"), { textOnly: true }],
              ["Delete host", A.byId("host-delete")],
            ]);
          }
          await A.tap(A.byId("host-delete"), "Delete host");
          // The themed sheet rises after the edit sheet has gone (never a sheet over a sheet).
          await A.waitNode(A.byId("host-delete-sheet-confirm"), 10_000, "delete sheet");
          assert(!A.find(A.byId("host-field-label")), "edit sheet still open under the confirm");
        };
        let first = true;
        for (const label of ["Laptop renamed", "Gateway", "Sandbox"]) {
          await openDeleteSheet(label, first);
          if (first) {
            await sleep(800);
            shot("47-delete-host-confirm-dark");
            auditControls(ctx, "delete confirm sheet", [
              ["sheet title (dialog)", (n) => n.desc.endsWith(", dialog"), { textOnly: true }],
              ["Cancel", A.byId("host-delete-sheet-cancel")],
              ["Delete", A.byId("host-delete-sheet-confirm")],
            ]);
            await A.tap(A.byId("host-delete-sheet-cancel"), "cancel delete");
            await A.waitGone(A.byId("host-delete-sheet-confirm"), 10_000, "delete sheet to close");
            assert(A.find(hostRow(label)), "Cancel deleted the host");
            await openDeleteSheet(label, false);
          }
          first = false;
          await A.tap(A.byId("host-delete-sheet-confirm"), "confirm delete");
          await A.waitGone(hostRow(label), 15_000, `${label} to go`);
        }
        await A.waitNode(A.byId("hosts-empty"), 15_000, "hosts empty");
        assert(!A.find(A.byId("hosts-add")), "the header + is shown over the empty hosts list");
        shot("48-hosts-empty-dark");
        E.gatewayStop();
      },
    ],
    [
      "The Pi icon on the launcher",
      async () => {
        night(true);
        A.key(3); // HOME
        await sleep(2000);
        A.swipe(540, 2000, 540, 500, 400);
        await sleep(2000);
        await A.waitNode(A.byText("Pi"), 10_000, "Pi in the app drawer");
        shot("49-launcher-icon-dark");
      },
    ],
  ];
}

export async function journey(args = []) {
  const screens = option(
    args,
    "--screens",
    path.join(os.homedir(), "projects/pi-mobile-work/screens-v11"),
  );
  const apk = option(
    args,
    "--apk",
    path.join(APP, "android/app/build/outputs/apk/release/app-release.apk"),
  );
  await E.up();
  const theme = option(args, "--theme", "dark");
  const ctx = {
    screens,
    light: theme === "light",
    dp: A.dpScale(),
    audit: [],
    sweep: [],
    notes: [],
    expectedSummary: `${E.readState().windows.real ? 2 : 1} awaiting input · 1 working · 3 completed`,
  };
  if (!args.includes("--no-install")) A.adb("install", "-r", apk);
  A.adb("logcat", "-c");
  A.reduceMotion(true);
  A.fontScale(1);
  A.nightMode(!ctx.light);
  // Earlier versions pre-confirmed Android's immersive-mode dialog for the (removed) landscape
  // terminal; the app never goes immersive now, so clear that device setting.
  A.adb("shell", "settings", "delete", "secure", "immersive_mode_confirmations");
  A.rotate(0);
  A.launch(PKG, { clear: true });
  const results = [];
  // --stop-after N: run the first N steps and leave the app and sandbox as they are (manual passes,
  // e.g. TalkBack, on a connected host). Implies --keep.
  const stopAfter = Number(option(args, "--stop-after", "0"));
  const plan = stopAfter > 0 ? steps(ctx).slice(0, stopAfter) : steps(ctx);
  for (const [name, fn] of plan) {
    const t0 = Date.now();
    // Every step starts in portrait (landscape steps rotate back themselves); re-lock it so a
    // stale rotation from an earlier run can never leak into a portrait assertion.
    A.rotate(0);
    try {
      await fn();
      results.push({ step: name, ok: true, ms: Date.now() - t0 });
      E.log(`PASS ${name}`);
    } catch (error) {
      results.push({
        step: name,
        ok: false,
        ms: Date.now() - t0,
        error: String(error?.message ?? error),
        rotation: A.displayRotation(),
      });
      E.log(`FAIL ${name}: ${error?.message ?? error} (display rotation ${A.displayRotation()})`);
      A.screenshot(screens, `_fail-${results.length}`);
      A.rotate(0);
      A.fontScale(1);
      break;
    }
  }
  fs.mkdirSync(screens, { recursive: true });
  fs.writeFileSync(
    path.join(screens, `journey-results-${theme}.json`),
    JSON.stringify({ results, notes: ctx.notes }, null, 2),
  );
  fs.writeFileSync(
    path.join(screens, `a11y-audit-${theme}.json`),
    JSON.stringify({ dpScale: ctx.dp, controls: ctx.audit, sweep: ctx.sweep }, null, 2),
  );
  const passed = results.filter((r) => r.ok).length;
  E.log(`${passed}/${plan.length} steps passed`);
  for (const note of ctx.notes) E.log(`note: ${note}`);
  if (!args.includes("--keep") && stopAfter === 0) await E.down();
  if (passed !== plan.length) process.exitCode = 1;
}
