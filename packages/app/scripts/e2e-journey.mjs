// The automated device journey for scripts/e2e-emulator.mjs (`journey` command). Each step drives
// the real APK over adb and asserts an outcome on the device and on the isolated host (fake pi
// input logs, the private tmux server, the registry). Results go to <screens>/journey-results.json.
//
// Options: --apk PATH (default android/app/build/outputs/apk/release/app-release.apk),
//          --screens DIR (default ~/projects/pi-mobile-work/screens), --keep (leave the sandbox up),
//          --no-install (use the installed APK).

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
        assert(A.find(A.byText(digest)), "trust sheet does not show the sandbox host key");
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
        A.swipe(540, 2100, 540, 1300, 400);
        await sleep(1000);
        assert(A.find(A.byText(/ENOENT/)), "failed tool error not in the detail sheet");
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
        await sleep(3000);
        shot("14-terminal-landscape-dark");
        ctx.notes.push(
          `rotation to landscape: client stays ${clientSize()} (manifest screenOrientation=portrait)`,
        );
        A.rotate(0);
        await sleep(2000);
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
      "Light mode: dashboard, chat, terminal, hosts",
      async () => {
        A.nightMode(false);
        await sleep(3000);
        shot("28-dashboard-light");
        await A.tap(rowOf(E.readState().richId), "rich row");
        await A.waitNode(A.byId("chat-list"), 30_000, "chat");
        await sleep(2500);
        shot("29-chat-light");
        await A.tap(A.byId("session-tab-terminal"), "terminal tab");
        await A.waitNode(A.byId("key-bar"), 20_000, "key bar");
        await sleep(4000);
        shot("30-terminal-light");
        await toDashboard();
        await back();
        await A.waitNode(A.idPrefix("host-row-"), 20_000, "hosts");
        shot("31-hosts-list-light");
        A.nightMode(true);
      },
    ],
  ];
}

export async function journey(args = []) {
  const screens = option(
    args,
    "--screens",
    path.join(os.homedir(), "projects/pi-mobile-work/screens"),
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
  A.reduceMotion(true);
  A.nightMode(true);
  A.rotate(0);
  A.launch(PKG, { clear: true });
  const results = [];
  for (const [name, fn] of steps(ctx)) {
    const t0 = Date.now();
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
      });
      E.log(`FAIL ${name}: ${error?.message ?? error}`);
      A.screenshot(screens, `_fail-${results.length}`);
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
