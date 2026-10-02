// The automated device journey for scripts/e2e-emulator.mjs (`journey` command). Each step drives
// the real APK over adb and asserts an outcome on the device and on the isolated host (fake pi
// input logs, the private tmux server, the registry). Results go to <screens>/journey-results.json.
//
// Options: --apk PATH (default android/app/build/outputs/apk/release/app-release.apk),
//          --screens DIR (default ~/projects/pi-mobile-work/screens-v5), --keep (leave the sandbox up),
//          --no-install (use the installed APK), --stop-after N (first N steps, sandbox kept),
//          --theme dark|light (default dark: the run's
//          base appearance; with light, every "-dark" shot is taken in light mode as "-light").
// Accessibility: every main control is checked for a label and a ≥44dp hit area (bounds plus its
// declared hitSlop) on the device; the table goes to <screens>/a11y-audit-<theme>.json.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as A from "./e2e-adb.mjs";
import * as E from "./e2e-emulator.mjs";

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
const clientSize = () => E.tmux("list-clients", "-F", "#{client_width}x#{client_height}").trim();
const pimSessions = () => E.sessionsList().filter((line) => line.startsWith("pim-"));

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

const widthOf = (size) => Number(size.split("x")[0]);

/** The webview's renderer choice, as logged by the RN side (`[terminal-webview] terminal renderer`). */
function rendererLog() {
  const lines = A.adb("logcat", "-d", "-s", "ReactNativeJS:I")
    .split("\n")
    .filter((line) => line.includes("terminal renderer"));
  const last = lines.pop();
  return last ? last.slice(last.indexOf("[terminal-webview]")) : "no renderer log line";
}

/** 44dp with 1px of rounding (bounds are whole pixels: 44dp = 115.5px at 2.625x). */
const MIN_TARGET_DP = 43.5;
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
      `a11y ${screen}: ${label} hit area ${round1(w)}x${round1(h)}dp < 44dp`,
    );
    if (opts.selected !== undefined)
      assert(node.selected === opts.selected, `a11y ${screen}: ${label} selected=${node.selected}`);
  }
  sweepClickables(ctx, screen, nodes);
}

/** Every other clickable node of the app on screen: recorded when unnamed or under 44dp. */
function sweepClickables(ctx, screen, nodes) {
  const webviews = nodes.filter((n) => n.cls === "android.webkit.WebView");
  for (const node of nodes) {
    if (!(node.clickable || node.longClickable) || node.pkg !== PKG) continue;
    if (webviews.some((w) => w !== node && inside(node, w))) continue;
    const [x1, y1, x2, y2] = node.bounds;
    const w = (x2 - x1) / ctx.dp;
    const h = (y2 - y1) / ctx.dp;
    const name = spokenName(node, nodes);
    if (name && Math.min(w, h) >= MIN_TARGET_DP) continue;
    ctx.sweep.push({ screen, id: node.id, cls: node.cls, name, wDp: round1(w), hDp: round1(h) });
  }
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
      },
    ],
    [
      "Completed session: chat renders every item kind; tool detail sheet",
      async () => {
        await A.tap(rowOf(E.readState().richId), "rich row");
        await A.waitNode(A.byId("chat-list"), 30_000, "chat");
        await sleep(2500);
        shot("07-chat-completed-bottom-dark");
        auditControls(ctx, "chat", [
          ["Back", byDesc("Back")],
          ["Chat tab", A.byId("session-tab-chat"), { selected: true }],
          ["Terminal tab", A.byId("session-tab-terminal"), { selected: false }],
          ["composer field", A.byId("chat-composer")],
          ["Send", A.byId("chat-send")],
          ["assistant copy", A.byId("assistant-turn-copy"), { slop: 14, optional: true }],
        ]);
        assert(A.find(A.byText("Fixed: login redirect loop")), "markdown heading missing");
        A.swipe(540, 900, 540, 1900, 400);
        await sleep(1200);
        shot("08-chat-completed-mid-dark");
        A.swipe(540, 900, 540, 1900, 400);
        await sleep(1200);
        shot("09-chat-completed-top-dark");
        // The timestamp and copy under a user bubble stay hidden until a long-press.
        assert(
          !A.find(A.byId("user-message-timestamp")),
          "bubble timestamp shown before long-press",
        );
        const bubble = await A.waitNode(A.byId("user-message-bubble"), 10_000, "user bubble");
        const [bx, by] = A.center(bubble);
        A.swipe(bx, by, bx, by, 900);
        await A.waitNode(A.byId("user-message-timestamp"), 5000, "timestamp after long-press");
        await sleep(500);
        shot("55-chat-bubble-revealed-dark");
        auditControls(ctx, "chat (bubble revealed)", [
          ["Copy message", A.byId("user-message-copy"), { slop: 14 }],
        ]);
        const nodes = A.dump();
        for (const label of [
          "Thinking",
          "Context compacted",
          "Let me look at how sessions are checked.",
        ])
          assert(nodes.some(A.byText(label)), `missing ${label}`);
        for (const desc of [
          /^Shell, git log/,
          /^Search, redirect/,
          /^Read, src\/auth/,
          /^Edit, src\/auth\/sesion/,
        ])
          assert(nodes.some(A.byText(desc)), `missing tool ${desc}`);
        assert(nodes.some(A.byId("user-message")), "missing user message");
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
      "Waiting session → Answer in terminal → key bar + soft keyboard bytes",
      async () => {
        await A.tap(rowOf(sessionIdOf("waiting")), "waiting row");
        await A.waitNode(A.byId("chat-waiting-banner"), 30_000, "waiting banner");
        shot("11-chat-waiting-banner-dark");
        auditControls(ctx, "waiting banner", [
          ["Answer in terminal", A.byId("chat-answer-in-terminal")],
        ]);
        await A.tap(A.byId("chat-answer-in-terminal"), "answer in terminal");
        await A.waitNode(A.byId("key-bar"), 20_000, "key bar");
        await E.waitFor(() => pimSessions().length === 1, 20_000, "pim-* grouped session");
        await sleep(3000);
        shot("12-terminal-waiting-dark");
        auditControls(ctx, "terminal", [
          ["Terminal tab", A.byId("session-tab-terminal"), { selected: true }],
          ["Chat tab", A.byId("session-tab-chat"), { selected: false }],
          ["terminal surface", (n) => n.desc.startsWith("Terminal for "), { textOnly: true }],
          ...[
            "escape",
            "tab",
            "ctrl",
            "arrowup",
            "arrowdown",
            "arrowleft",
            "arrowright",
            "enter",
          ].map((k) => [`key ${k}`, A.byId(`key-${k}`)]),
        ]);
        ctx.notes.push(`renderer: ${rendererLog()}`);
        const n = eventCount("waiting");
        for (const k of [
          "key-escape",
          "key-arrowup",
          "key-arrowdown",
          "key-arrowleft",
          "key-arrowright",
          "key-tab",
        ])
          await A.tap(A.byId(k), k);
        await A.tap(A.byId("key-ctrl"), "ctrl");
        await sleep(600);
        assert(A.find(A.byId("key-ctrl")).selected, "Ctrl did not stay armed");
        shot("15-terminal-ctrl-armed-dark");
        await A.tap(A.byId("key-arrowup"), "ctrl+up");
        await A.tap(A.byId("key-ctrl"), "ctrl");
        const before = clientSize();
        await A.tap(A.byId("terminal-surface"), "surface");
        await sleep(1500);
        assert(A.keyboardShown(), "soft keyboard did not open");
        A.typeText("a");
        await sleep(500);
        A.typeText("hi");
        await sleep(1500);
        shot("13-terminal-keyboard-dark");
        const withKeyboard = clientSize();
        A.hideKeyboard();
        await sleep(2000);
        const hex = inputHex("waiting", n);
        const want = [
          "1b",
          "1b5b41",
          "1b5b42",
          "1b5b44",
          "1b5b43",
          "09",
          "1b5b313b3541",
          "01",
          "68",
          "69",
        ];
        const joined = hex.join(" ");
        assert(joined.replace(/ /g, "") === want.join(""), `bytes ${joined} != ${want.join(" ")}`);
        assert(
          withKeyboard !== before && clientSize() === before,
          `pty resize ${before} → ${withKeyboard} → ${clientSize()}`,
        );
        ctx.notes.push(`pty size ${before} → ${withKeyboard} with the keyboard → ${clientSize()}`);
        A.rotate(1);
        await E.waitFor(() => widthOf(clientSize()) > widthOf(before), 10_000, "landscape pty");
        // Collapsed: no header or sub-bar, the leading ‹ Chat key, immersive system bars.
        await A.waitNode(A.byId("key-to-chat"), 10_000, "‹ Chat key (collapsed landscape)");
        await sleep(2000);
        assert(!A.find(A.byId("session-tabs")), "sub-bar still shown in collapsed landscape");
        assert(!A.find(A.byId("screen-header")), "header still shown in collapsed landscape");
        shot("14-terminal-landscape-dark");
        auditControls(ctx, "terminal (collapsed landscape)", [["‹ Chat", A.byId("key-to-chat")]]);
        const landscape = clientSize();
        A.rotate(0);
        await E.waitFor(() => clientSize() === before, 10_000, "portrait pty again");
        await A.waitNode(A.byId("session-tabs"), 10_000, "sub-bar restored in portrait");
        assert(!A.find(A.byId("key-to-chat")), "‹ Chat key shown in portrait");
        ctx.notes.push(`rotation: pty ${before} portrait → ${landscape} landscape → ${before}`);
        // ‹ Chat switches to Chat and restores the chrome, still in landscape.
        A.rotate(1);
        await A.tap(A.byId("key-to-chat"), "‹ Chat", 10_000);
        await A.waitNode(A.byId("chat-list"), 10_000, "chat after ‹ Chat");
        await A.waitNode(A.byId("session-tabs"), 10_000, "sub-bar after ‹ Chat");
        assert(A.find(A.byId("screen-header")), "header not restored after ‹ Chat");
        await sleep(1500);
        shot("50-landscape-after-to-chat-dark");
        // System back while collapsed goes to Chat, not out of the session.
        await A.tap(A.byId("session-tab-terminal"), "terminal tab (landscape)");
        await A.waitNode(A.byId("key-to-chat"), 15_000, "collapsed again");
        await back();
        await A.waitNode(A.byId("chat-list"), 10_000, "chat after system back");
        assert(A.find(A.byId("session-tabs")), "system back left the session");
        assert(!A.find(A.byId("dashboard-composer")), "system back went to the dashboard");
        A.rotate(0);
        await sleep(1500);
        await A.tap(A.byId("session-tab-terminal"), "terminal tab (portrait)");
        await E.waitFor(() => pimSessions().length === 1, 20_000, "pim-* session again");
      },
    ],
    [
      "Leaving the terminal kills only the phone's pim-* session",
      async () => {
        const windows = E.tmux("list-windows", "-t", "pi", "-F", "#{window_id}").trim();
        await toDashboard();
        await E.waitFor(() => pimSessions().length === 0, 15_000, "pim-* session to go");
        assert(
          E.sessionsList().some((s) => s.startsWith("pi ")),
          "user session pi is gone",
        );
        const after = E.tmux("list-windows", "-t", "pi", "-F", "#{window_id}").trim();
        assert(after === windows, "user windows changed");
      },
    ],
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
        const landscapeScroll = { from: [1200, 850], to: [1200, 350] };
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
      "Real pi + forge in the Terminal tab, portrait and landscape (PIM_E2E_REAL_PI=1)",
      async () => {
        if (!E.readState().windows.real) {
          ctx.notes.push("real pi: skipped (PIM_E2E_REAL_PI unset)");
          return;
        }
        const row = await scrollUntil(rowOf(realSessionId()), "real pi row");
        A.tapNode(row);
        await A.tap(A.byId("session-tab-terminal"), "terminal tab", 30_000);
        await A.waitNode(A.byId("key-bar"), 20_000, "key bar");
        await E.waitFor(() => pimSessions().length === 1, 20_000, "pim-* grouped session");
        await sleep(6000);
        shot("32-terminal-real-pi-forge-dark");
        const portrait = clientSize();
        A.rotate(1);
        await E.waitFor(
          () => widthOf(clientSize()) > widthOf(portrait),
          10_000,
          "landscape pty (real pi)",
        );
        await sleep(5000);
        shot("33-terminal-real-pi-landscape-dark");
        ctx.notes.push(`real pi: pty ${portrait} → ${clientSize()}; ${rendererLog()}`);
        A.rotate(0);
        await sleep(2000);
        await toDashboard();
      },
    ],
    [
      "Send a prompt from Chat to an idle session (bracketed paste + Enter)",
      async () => {
        const n = eventCount("idle");
        await A.tap(rowOf(sessionIdOf("idle")), "idle row");
        await typeInto("chat-composer", "Add a fourth bullet about tests");
        shot("16-chat-composer-typing-dark");
        await A.tap(A.byId("chat-send"), "send");
        shot("17-chat-sent-optimistic-dark");
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
        // The sub-bar names the connection, never a stale "Idle".
        const state = await A.waitNode(
          A.byText(/^(Reconnecting…|Connecting…|Not connected)/),
          20_000,
          "connection state in the sub-bar",
        );
        assert(state.id === "session-state", `connection text is not the sub-bar (${state.id})`);
        ctx.notes.push(`sub-bar while disconnected: "${state.text}"`);
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
            assert(
              visible(A.find(A.byId("dashboard-send"))),
              `dashboard send off screen @${scale}`,
            );
            const row = await scrollUntil(rowOf(E.readState().richId), "rich row");
            A.tapNode(row);
            await A.waitNode(A.byId("chat-list"), 30_000, `chat @${scale}`);
            await sleep(2500);
            shot(`${n + 2}-fs${tag}-chat-dark`);
            auditControls(ctx, `chat @${scale}`, [
              ["Chat tab", A.byId("session-tab-chat"), { selected: true }],
              ["Terminal tab", A.byId("session-tab-terminal")],
              ["Send", A.byId("chat-send")],
            ]);
            const nodes = A.dump();
            const status = nodes.find(A.byId("session-state"));
            const tabs = nodes.find(A.byId("session-tabs"));
            assert(visible(status) && visible(tabs), `sub-bar clipped @${scale}`);
            assert(
              status.bounds[2] <= tabs.bounds[0],
              `sub-bar status overlaps the tabs @${scale}`,
            );
            assert(visible(nodes.find(A.byId("chat-composer"))), `composer off screen @${scale}`);
            ctx.notes.push(
              `font ${scale}: sub-bar status "${status.text}" ${status.bounds}, tabs ${tabs.bounds}`,
            );
            await toDashboard();
            await back();
            await A.tap(A.byId("hosts-add"), `add host @${scale}`);
            await A.waitNode(A.byId("host-field-label"), 20_000, `host form @${scale}`);
            await sleep(1500);
            A.hideKeyboard();
            await sleep(600);
            shot(`${n + 3}-fs${tag}-add-host-dark`);
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
      "Light mode: dashboard, chat, tool sheet, terminal, hosts",
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
        await A.tap(A.byId("session-tab-terminal"), "terminal tab");
        await A.waitNode(A.byId("key-bar"), 20_000, "key bar");
        await sleep(4000);
        shot("30-terminal-light");
        A.rotate(1);
        await A.waitNode(A.byId("key-to-chat"), 15_000, "collapsed terminal (light)");
        await sleep(3000);
        shot("52-terminal-landscape-collapsed-light");
        A.rotate(0);
        await sleep(2000);
        await toDashboard();
        await back();
        await A.waitNode(A.idPrefix("host-row-"), 20_000, "hosts");
        shot("31-hosts-list-light");
      },
    ],
    [
      "Password sign-in (password gateway) → trust sheet → dashboard, light",
      async () => {
        const gw = await E.gatewayStart();
        await A.tap(A.byId("hosts-add"), "add host");
        await A.waitNode(A.byId("host-public-key"), 20_000, "add host sheet");
        await fillAddress("Gateway", gw.port);
        await A.tap(A.byId("host-auth-password"), "password mode");
        await typeInto("host-field-password", gw.password);
        A.hideKeyboard();
        await sleep(600);
        shot("40-add-host-password-light");
        await A.tap(A.byId("host-save"), "save");
        await A.tap(hostRow("Gateway"), "Gateway row", 15_000);
        await A.waitNode(A.byId("host-key-sheet"), 40_000, "trust sheet");
        const digest = E.readState().hostFingerprint.replace(/^SHA256:/, "");
        assert(A.find(A.byText(digest)), "trust sheet does not show the gateway host key");
        shot("41-trust-host-key-light");
        await A.tap(A.byId("host-key-trust"), "trust");
        await A.waitNode(A.byId("dashboard-summary"), 45_000, "dashboard over password auth");
        await sleep(2500);
        shot("42-dashboard-password-host-light");
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
        A.hideKeyboard();
        await sleep(800);
        shot("44-add-host-paste-dark");
        // A drag that starts on the multiline key field scrolls the sheet (the field never scrolls).
        const field = A.find(A.byId("host-field-private-key"));
        const [fx, fy] = A.center(field);
        // The sheet may already sit at its scroll end: try up, then down; either must move it.
        A.swipe(fx, fy, fx, Math.max(200, fy - 600), 500);
        await sleep(1000);
        let moved = A.find(A.byId("host-field-private-key"));
        if (moved && Math.abs(moved.bounds[1] - field.bounds[1]) < 100) {
          A.swipe(fx, fy, fx, Math.min(2200, fy + 600), 500);
          await sleep(1000);
          moved = A.find(A.byId("host-field-private-key"));
        }
        // Open (report-a11y.md): the field no longer scrolls itself, but a drag that starts on it
        // still does not scroll the sheet. Recorded, not asserted, until that is fixed.
        const sheetMoved = moved && Math.abs(moved.bounds[1] - field.bounds[1]) >= 100;
        ctx.notes.push(
          `key-field drag (open item): sheet ${sheetMoved ? "scrolled" : "did not scroll"}, field top ${field.bounds[1]} → ${moved?.bounds[1]}px`,
        );
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
      "Delete every host → Hosts empty state, light",
      async () => {
        night(false);
        await sleep(1500);
        await toDashboard();
        await back();
        const openDeleteSheet = async (label, first) => {
          const id = await hostIdOf(label);
          await A.tap(A.byId(`host-edit-${id}`), `edit ${label}`);
          await A.waitNode(A.byId("host-field-label"), 15_000, "edit sheet");
          // uiautomator lists the button even while it sits behind the sticky footer, so scroll
          // until it is clear of Cancel/Save, then tap where it is now.
          await revealAboveFooter("host-delete", "host-save");
          if (first) {
            shot("54-edit-host-delete-row-light");
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
            shot("47-delete-host-confirm-light");
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
        shot("48-hosts-empty-light");
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
    path.join(os.homedir(), "projects/pi-mobile-work/screens-v5"),
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
  // Android shows a one-time "Viewing full screen" dialog the first time an app goes immersive (the
  // collapsed landscape terminal). It takes window focus, hiding the app from uiautomator; a real
  // user dismisses it once. Pre-confirm it on the test device.
  A.adb("shell", "settings", "put", "secure", "immersive_mode_confirmations", "confirmed");
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
