// The automated device journey for scripts/e2e-emulator.mjs (`journey` command). Each step drives
// the real APK over adb and asserts an outcome on the device and on the isolated host (fake pi
// input logs, the private tmux server, the registry). Results go to <screens>/journey-results.json.
//
// Options: --apk PATH (default android/app/build/outputs/apk/release/app-release.apk),
//          --screens DIR (default ~/projects/pi-mobile-work/screens-v2), --keep (leave the sandbox up),
//          --no-install (use the installed APK).

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

async function toDashboard() {
  for (let i = 0; i < 3 && !A.find(A.byId("dashboard-summary")); i++) await back();
  await A.waitNode(A.byId("dashboard-summary"), 20_000, "dashboard");
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

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

function steps(ctx) {
  const shot = (name) => A.screenshot(ctx.screens, name);
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
      },
    ],
    [
      "Completed session: chat renders every item kind; tool detail sheet",
      async () => {
        await A.tap(rowOf(E.readState().richId), "rich row");
        await A.waitNode(A.byId("chat-list"), 30_000, "chat");
        await sleep(2500);
        shot("07-chat-completed-bottom-dark");
        assert(A.find(A.byText("Fixed: login redirect loop")), "markdown heading missing");
        A.swipe(540, 900, 540, 1900, 400);
        await sleep(1200);
        shot("08-chat-completed-mid-dark");
        A.swipe(540, 900, 540, 1900, 400);
        await sleep(1200);
        shot("09-chat-completed-top-dark");
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
        await A.tap(A.byId("chat-answer-in-terminal"), "answer in terminal");
        await A.waitNode(A.byId("key-bar"), 20_000, "key bar");
        await E.waitFor(() => pimSessions().length === 1, 20_000, "pim-* grouped session");
        await sleep(3000);
        shot("12-terminal-waiting-dark");
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
        await sleep(1500);
        shot("14-terminal-landscape-dark");
        const landscape = clientSize();
        A.rotate(0);
        await E.waitFor(() => clientSize() === before, 10_000, "portrait pty again");
        ctx.notes.push(`rotation: pty ${before} portrait → ${landscape} landscape → ${before}`);
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
        shot("25-reconnecting-banner-dark");
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
      "Light mode: dashboard, chat, tool sheet, terminal, hosts",
      async () => {
        A.nightMode(false);
        await sleep(3000);
        shot("28-dashboard-light");
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
        A.nightMode(true);
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
        await A.waitNode(A.byId("host-delete"), 15_000, "edit sheet");
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
        A.nightMode(false);
        await sleep(1500);
        await toDashboard();
        await back();
        let first = true;
        for (const label of ["Laptop renamed", "Gateway", "Sandbox"]) {
          const id = await hostIdOf(label);
          await A.tap(A.byId(`host-edit-${id}`), `edit ${label}`);
          await A.tap(A.byId("host-delete"), "delete");
          // RN's Android Alert puts the last (destructive) button on button1.
          await A.waitNode(A.byId("button1"), 10_000, "delete confirmation");
          if (first) shot("47-delete-host-confirm-light");
          first = false;
          await A.tap(A.byId("button1"), "confirm delete");
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
        A.nightMode(true);
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
    path.join(os.homedir(), "projects/pi-mobile-work/screens-v2"),
  );
  const apk = option(
    args,
    "--apk",
    path.join(APP, "android/app/build/outputs/apk/release/app-release.apk"),
  );
  await E.up();
  const ctx = {
    screens,
    notes: [],
    expectedSummary: `${E.readState().windows.real ? 2 : 1} awaiting input · 1 working · 3 completed`,
  };
  if (!args.includes("--no-install")) A.adb("install", "-r", apk);
  A.adb("logcat", "-c");
  A.reduceMotion(true);
  A.nightMode(true);
  A.rotate(0);
  A.launch(PKG, { clear: true });
  const results = [];
  for (const [name, fn] of steps(ctx)) {
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
      break;
    }
  }
  fs.mkdirSync(screens, { recursive: true });
  fs.writeFileSync(
    path.join(screens, "journey-results.json"),
    JSON.stringify({ results, notes: ctx.notes }, null, 2),
  );
  const passed = results.filter((r) => r.ok).length;
  E.log(`${passed}/${steps(ctx).length} steps passed`);
  for (const note of ctx.notes) E.log(`note: ${note}`);
  if (!args.includes("--keep")) await E.down();
  if (passed !== steps(ctx).length) process.exitCode = 1;
}
