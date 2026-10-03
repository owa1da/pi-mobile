#!/usr/bin/env node
// End-to-end harness: an isolated host sandbox (user-space sshd + private tmux + temp agent dir +
// fake pi) and an adb-driven journey through the real APK on an Android emulator.
//
// Usage (from packages/app):
//   node scripts/e2e-emulator.mjs up            # create the sandbox and seed sessions; prints state
//   node scripts/e2e-emulator.mjs journey [--apk PATH] [--screens DIR] [--keep]
//                                               # (re)install the APK, run every journey check,
//                                               # save screenshots, tear the sandbox down unless --keep
//   node scripts/e2e-emulator.mjs down          # stop sshd and the private tmux server, remove the dir
//   node scripts/e2e-emulator.mjs status | sshd-stop | sshd-start | hostkey-rotate | hostkey-restore
//   node scripts/e2e-emulator.mjs authorize "<ssh-ed25519 AAAA… comment>"
//   node scripts/e2e-emulator.mjs events <window>   # fake-pi input log for a seeded window
//
// Prerequisites: a booted emulator visible to `adb` (e.g. `sg kvm -c "emulator -avd pi_ssh_test
// -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect"`), ANDROID_HOME/platform-tools on
// PATH, /usr/sbin/sshd, tmux, ssh-keygen. The emulator reaches the host at 10.0.2.2.
//
// Safety: everything lives in $PIM_E2E_DIR (default /tmp/pim-e2e). sshd runs on 127.0.0.1:$PIM_E2E_PORT
// (default 42622) with its own host key and authorized_keys. Its sessions get HOME=<sandbox home>
// and SHELL=/bin/sh via SetEnv, and the sandbox .profile exports PI_CODING_AGENT_DIR, TMUX_TMPDIR
// and a PATH whose `pi` is the fake pi. tmux is always driven with `-S <sandbox socket> -f /dev/null`.
// It never touches ~/.ssh, the system sshd, the user's tmux server or ~/.pi/agent.
//
// Optional: PIM_E2E_REAL_PI=1 adds one window running the real `pi` (forge from the remote-channel
// worktree ~/projects/pi-mobile-work/forge-remote or $PIM_E2E_FORGE, plus a test-only `/pimrig`
// extension) with PI_CODING_AGENT_DIR=<sandbox agent dir> and no prompt, so no model call is made.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const FAKE_PI = path.join(APP, "src/host/test-support/fake-pi.mjs");
const ROOT = process.env.PIM_E2E_DIR || "/tmp/pim-e2e";
const PORT = Number(process.env.PIM_E2E_PORT || 42622);
const SSHD_DIR = path.join(ROOT, "sshd");
const HOME = path.join(ROOT, "home");
const AGENT = path.join(HOME, ".pi", "agent");
const PROCS = path.join(AGENT, "forge", "procs");
const BIN = path.join(ROOT, "bin");
const TMUX_TMPDIR = path.join(ROOT, "tmux");
const UID = os.userInfo().uid;
const SOCKET = path.join(TMUX_TMPDIR, `tmux-${UID}`, "default");
const WORK = path.join(ROOT, "work");
const STATE = path.join(ROOT, "state.json");
const USER = os.userInfo().username;
const HOSTNAME = os.hostname();

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log("[e2e]", ...args);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  fs.writeFileSync(STATE, JSON.stringify({ ...readState(), ...patch }, null, 2));
}

async function waitFor(fn, timeoutMs = 15_000, label = "condition", intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

function tmuxEnv() {
  const env = {
    HOME,
    USER,
    LOGNAME: USER,
    SHELL: "/bin/sh",
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    PATH: `${BIN}:/usr/local/bin:/usr/bin:/bin`,
    TMUX_TMPDIR,
    PI_CODING_AGENT_DIR: AGENT,
    PI_SKIP_VERSION_CHECK: "1",
    FAKE_PI_DELAY_MS: "300",
    FAKE_PI_BTW_MS: "8000",
  };
  return env;
}

export function tmux(...args) {
  return run("tmux", ["-S", SOCKET, "-f", "/dev/null", ...args], { env: tmuxEnv() });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// sshd
// ---------------------------------------------------------------------------

function sshdConfig(hostKey) {
  return [
    `Port ${PORT}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${hostKey}`,
    `PidFile ${path.join(SSHD_DIR, "sshd.pid")}`,
    `AuthorizedKeysFile ${path.join(SSHD_DIR, "authorized_keys")}`,
    "StrictModes no",
    "UsePAM no",
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PermitRootLogin no",
    "PerSourcePenalties no",
    "MaxStartups 100",
    "PermitUserEnvironment no",
    "PermitUserRC no",
    "PrintMotd no",
    "PrintLastLog no",
    "X11Forwarding no",
    "AllowAgentForwarding no",
    "AllowTcpForwarding no",
    // The sandbox: login shells read <sandbox home>/.profile, never the user's dotfiles.
    `SetEnv HOME=${HOME} SHELL=/bin/sh`,
    "LogLevel VERBOSE",
    "",
  ].join("\n");
}

function hostKeyPath() {
  return readState().hostKey ?? path.join(SSHD_DIR, "host_ed25519_a");
}

function fingerprint(pubPath) {
  return run("ssh-keygen", ["-lf", pubPath]).trim().split(/\s+/)[1];
}

export async function sshdStart() {
  const pidFile = path.join(SSHD_DIR, "sshd.pid");
  const old = readState().sshdPid;
  if (old && pidAlive(old)) return old;
  const hostKey = hostKeyPath();
  fs.writeFileSync(path.join(SSHD_DIR, "sshd_config"), sshdConfig(hostKey));
  fs.rmSync(pidFile, { force: true });
  const logFd = fs.openSync(path.join(SSHD_DIR, "sshd.log"), "a");
  const child = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", path.join(SSHD_DIR, "sshd_config")], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  await waitFor(
    () => fs.readFileSync(path.join(SSHD_DIR, "sshd.log"), "utf8").includes(`port ${PORT}`),
    10_000,
    "sshd to listen",
  );
  writeState({ sshdPid: child.pid, hostFingerprint: fingerprint(`${hostKey}.pub`) });
  log(`sshd pid ${child.pid} on 127.0.0.1:${PORT} host key ${fingerprint(`${hostKey}.pub`)}`);
  return child.pid;
}

/** Descendant pids of `pid` (sshd-session children of the listener). */
function descendants(pid) {
  const out = run("ps", ["-e", "-o", "pid=,ppid=,comm="]);
  const rows = out
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .map(([p, pp, comm]) => ({ pid: Number(p), ppid: Number(pp), comm }));
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const row of rows)
      if (row.ppid === parent) {
        found.push(row);
        queue.push(row.pid);
      }
  }
  return found;
}

/** Stops the listener and every connection it forked (simulates the host going away). */
export async function sshdStop() {
  const pid = readState().sshdPid;
  if (!pid || !pidAlive(pid)) return;
  const children = descendants(pid).filter((row) => row.comm.startsWith("sshd"));
  for (const row of children)
    try {
      process.kill(row.pid, "SIGTERM");
    } catch {
      // gone
    }
  process.kill(pid, "SIGTERM");
  await waitFor(() => !pidAlive(pid), 5_000, "sshd to exit");
  writeState({ sshdPid: null });
  log(`sshd stopped (${children.length} connection process(es) killed)`);
}

/** Restarts sshd with a different host key (the app must refuse it). */
export async function hostkeyRotate() {
  const next = path.join(SSHD_DIR, "host_ed25519_b");
  if (!fs.existsSync(next))
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "pim-e2e-host-b", "-f", next]);
  await sshdStop();
  writeState({ hostKey: next });
  await sshdStart();
}

export async function hostkeyRestore() {
  await sshdStop();
  writeState({ hostKey: path.join(SSHD_DIR, "host_ed25519_a") });
  await sshdStart();
}

export function authorize(line) {
  fs.appendFileSync(path.join(SSHD_DIR, "authorized_keys"), `${line.trim()}\n`);
  log("authorized", line.trim().slice(0, 60), "…");
}

// ---------------------------------------------------------------------------
// seeded sessions
// ---------------------------------------------------------------------------

function entryChain(lines) {
  let parent = null;
  let n = 0;
  const t0 = Date.now() - 50 * 60_000;
  return lines.map((entry) => {
    n++;
    const id = entry.id ?? `e${String(n).padStart(7, "0")}`;
    const ts = t0 + n * 20_000;
    const full = { ...entry, id, parentId: parent, timestamp: new Date(ts).toISOString() };
    if (full.message) full.message = { timestamp: ts, ...full.message };
    parent = id;
    return full;
  });
}

const asst = (content, extra = {}) => ({
  type: "message",
  message: {
    role: "assistant",
    content,
    provider: "anthropic",
    model: "claude-opus-5-5",
    stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop",
    ...extra,
  },
});
const user = (text) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});
const result = (toolCallId, toolName, text, isError = false) => ({
  type: "message",
  message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError },
});

const FINAL_MARKDOWN = `## Fixed: login redirect loop

The loop came from \`useSession\` treating an **expired** token as signed in.

### Changes
- \`src/auth/session.ts\`: check \`expiresAt\` before trusting the cached token
- \`src/auth/session.test.ts\`: new case for an expired token
- Removed the duplicate redirect in \`routes/login.tsx\`

\`\`\`ts
export function isSignedIn(session: Session | null, now = Date.now()): boolean {
  return session !== null && session.expiresAt > now;
}
\`\`\`

All 42 tests pass. Want me to open a PR?`;

function richSession(sessionId, cwd) {
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date(Date.now() - 3_600_000).toISOString(),
    cwd,
  };
  const entries = entryChain([
    {
      type: "message",
      message: { role: "system", content: "", sections: { preamble: "You are pi." } },
    },
    { type: "model_change", provider: "anthropic", modelId: "claude-opus-5-5" },
    user("The login page redirects forever after my token expires. Find the cause and fix it."),
    asst([
      {
        type: "thinking",
        thinking:
          "Start by locating where the session is read and where redirects happen. A grep for `redirect(` and `useSession` should narrow it down.",
      },
      { type: "text", text: "Let me look at how sessions are checked." },
      {
        type: "toolCall",
        id: "call_bash_1",
        name: "bash",
        arguments: { command: "git log --oneline -5 && ls src/auth" },
      },
    ]),
    result(
      "call_bash_1",
      "bash",
      "a1b2c3d fix: header spacing\n9f8e7d6 feat: remember me\n…\nsession.ts\nsession.test.ts\nguard.tsx",
    ),
    asst([
      {
        type: "toolCall",
        id: "call_grep_1",
        name: "grep",
        arguments: { pattern: "redirect\\(", path: "src" },
      },
    ]),
    result(
      "call_grep_1",
      "grep",
      'src/routes/login.tsx:31:    redirect("/home")\nsrc/auth/guard.tsx:12:  if (!isSignedIn(s)) redirect("/login")',
    ),
    {
      type: "compaction",
      summary:
        "User reported an infinite redirect on the login page after token expiry. Found redirects in login.tsx and guard.tsx.",
      firstKeptEntryId: "e0000006",
      tokensBefore: 182000,
    },
    asst([
      {
        type: "toolCall",
        id: "call_read_1",
        name: "read",
        arguments: { path: "src/auth/session.ts", offset: 1, limit: 40 },
      },
    ]),
    result(
      "call_read_1",
      "read",
      "export function isSignedIn(session: Session | null): boolean {\n  return session !== null;\n}\n",
    ),
    asst([
      {
        type: "toolCall",
        id: "call_edit_1",
        name: "edit",
        arguments: {
          path: "src/auth/sesion.ts",
          edits: [
            {
              oldText: "return session !== null;",
              newText: "return session !== null && session.expiresAt > now;",
            },
          ],
        },
      },
    ]),
    result(
      "call_edit_1",
      "edit",
      "Error: ENOENT: no such file or directory, open 'src/auth/sesion.ts'",
      true,
    ),
    asst([
      { type: "text", text: "Typo in the path; retrying." },
      {
        type: "toolCall",
        id: "call_edit_2",
        name: "edit",
        arguments: {
          path: "src/auth/session.ts",
          edits: [
            {
              oldText:
                "export function isSignedIn(session: Session | null): boolean {\n  return session !== null;",
              newText:
                "export function isSignedIn(session: Session | null, now = Date.now()): boolean {\n  return session !== null && session.expiresAt > now;",
            },
          ],
        },
      },
    ]),
    result("call_edit_2", "edit", "Successfully replaced 1 block in src/auth/session.ts."),
    asst([
      {
        type: "toolCall",
        id: "call_bash_2",
        name: "bash",
        arguments: { command: "npm test -- --run src/auth" },
      },
    ]),
    result(
      "call_bash_2",
      "bash",
      " ✓ src/auth/session.test.ts (6 tests)\n ✓ src/auth/guard.test.tsx (3 tests)\n\n Test Files  2 passed (2)\n      Tests  42 passed (42)",
    ),
    asst([{ type: "text", text: FINAL_MARKDOWN }]),
  ]);
  return [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function endedSession(sessionId, cwd) {
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date(Date.now() - 7_200_000).toISOString(),
    cwd,
  };
  const entries = entryChain([
    user("Write a CHANGELOG entry for the 2.4 release"),
    asst([
      {
        type: "text",
        text: "Added a **2.4.0** section to `CHANGELOG.md` with the three user-facing changes.",
      },
    ]),
  ]);
  return [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function sessionPath(cwd, sessionId) {
  const dir = path.join(AGENT, "sessions", `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
}

function newWindow(name, cwd, argv, extraEnv = {}) {
  const env = Object.entries(extraEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const out = tmux(
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id} #{pane_pid}",
    "-t",
    "pi:",
    "-n",
    name,
    "-c",
    cwd,
    ...env,
    "--",
    ...argv,
  ).trim();
  const [pane, pid] = out.split(" ");
  return { name, pane, pid: Number(pid) };
}

const uuid = (tag) =>
  `0199${tag}-0000-7000-8000-${String(Date.now()).slice(-12).padStart(12, "0")}`;

async function seed() {
  for (const dir of ["api", "web", "infra", "docs", "site"])
    fs.mkdirSync(path.join(WORK, dir), { recursive: true });
  // The private tmux server, with a placeholder window that keeps it alive.
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true, mode: 0o700 });
  tmux(
    "new-session",
    "-d",
    "-s",
    "pi",
    "-n",
    "shell",
    "-x",
    "120",
    "-y",
    "40",
    "-c",
    HOME,
    "/bin/sh",
  );
  const windows = {};
  // (a) working: a prompt, then "/work" keeps it working until Escape.
  windows.working = newWindow("pi-working", path.join(WORK, "api"), [
    "pi",
    "--model",
    "anthropic/claude-opus-5-5",
    "--",
    "Refactor the rate limiter to use a token bucket",
  ]);
  // (b) waiting: a prompt, then SIGUSR2 opens a dialog (asking title).
  windows.waiting = newWindow(
    "pi-waiting",
    path.join(WORK, "infra"),
    ["pi", "--", "Deploy the staging stack and run the smoke tests"],
    {
      FAKE_PI_WAIT_TITLE: "Allow bash: terraform apply -auto-approve?",
      FAKE_PI_WAIT_OPTIONS: "Allow|Allow always|Deny",
    },
  );
  // (c) completed: a realistic session resumed (live, idle).
  const richId = uuid("aaaa");
  const richFile = sessionPath(path.join(WORK, "web"), richId);
  fs.writeFileSync(richFile, richSession(richId, path.join(WORK, "web")));
  windows.completed = newWindow("pi-completed", path.join(WORK, "web"), [
    "pi",
    "--session",
    richFile,
  ]);
  // (c2) idle: a short finished session to send prompts to.
  windows.idle = newWindow("pi-idle", path.join(WORK, "docs"), [
    "pi",
    "--",
    "Summarize the README in three bullets",
  ]);
  // (d) ended/: a closed session (quit 40 min ago) with an existing file and cwd.
  const endedId = uuid("bbbb");
  const endedFile = sessionPath(path.join(WORK, "site"), endedId);
  fs.writeFileSync(endedFile, endedSession(endedId, path.join(WORK, "site")));
  fs.mkdirSync(path.join(PROCS, "ended"), { recursive: true });
  fs.writeFileSync(
    path.join(PROCS, "ended", `${endedId}.json`),
    JSON.stringify({
      v: 1,
      host: HOSTNAME,
      pid: 999_999,
      sessionId: endedId,
      sessionFile: endedFile,
      cwd: path.join(WORK, "site"),
      name: null,
      firstPrompt: "Write a CHANGELOG entry for the 2.4 release",
      messages: 2,
      model: { provider: "anthropic", id: "claude-opus-5-5" },
      lastRun: {
        startedAt: Date.now() - 2_420_000,
        endedAt: Date.now() - 2_400_000,
        outcome: "completed",
        error: null,
      },
      lastText: "Added a 2.4.0 section to CHANGELOG.md",
      startedAt: Date.now() - 7_200_000,
      endedAt: Date.now() - 2_400_000,
      endReason: "quit",
    }) + "\n",
  );
  await waitFor(
    () => Object.values(windows).every((w) => fs.existsSync(path.join(PROCS, `${w.pid}.json`))),
    15_000,
    "fake pi records",
  );
  await waitFor(
    () => procState(windows.working.pid) === "idle",
    10_000,
    "working window first reply",
  );
  tmux("send-keys", "-t", windows.working.pane, "-l", "/work");
  tmux("send-keys", "-t", windows.working.pane, "Enter");
  await waitFor(
    () => procState(windows.waiting.pid) === "idle",
    10_000,
    "waiting window first reply",
  );
  process.kill(windows.waiting.pid, "SIGUSR2");
  await waitFor(() => procState(windows.working.pid) === "working", 10_000, "working state");
  await waitFor(() => procState(windows.waiting.pid) === "waiting", 10_000, "waiting state");
  if (process.env.PIM_E2E_REAL_PI === "1") windows.real = startRealPi();
  writeState({ windows, richId, richFile, endedId, endedFile });
  return windows;
}

/**
 * Writes `count` more ended/ records (closed rows), newest first, each with a real session file,
 * so the dashboard's Completed section overflows past its 5 closed rows ("Show N more").
 * Returns their session ids, oldest last.
 */
export function seedClosed(count) {
  const ids = [];
  const cwd = path.join(WORK, "docs");
  for (let i = 0; i < count; i++) {
    const sessionId = uuid(`c${String(i).padStart(3, "0")}`);
    const file = sessionPath(cwd, sessionId);
    fs.writeFileSync(file, endedSession(sessionId, cwd));
    const endedAt = Date.now() - (60 + i * 10) * 60_000;
    fs.writeFileSync(
      path.join(PROCS, "ended", `${sessionId}.json`),
      JSON.stringify({
        v: 1,
        host: HOSTNAME,
        pid: 900_000 + i,
        sessionId,
        sessionFile: file,
        cwd,
        name: `Archived task ${i + 1}`,
        firstPrompt: `Archived task ${i + 1}`,
        messages: 2,
        model: { provider: "zai", id: "glm-5.3-flash" },
        lastRun: { startedAt: endedAt - 20_000, endedAt, outcome: "completed", error: null },
        lastText: "Done.",
        startedAt: endedAt - 600_000,
        endedAt,
        endReason: "quit",
      }) + "\n",
    );
    ids.push(sessionId);
  }
  log(`seeded ${count} closed sessions`);
  return ids;
}

/**
 * Drives a fake pi's remote channel (forge's side, see fake-pi.mjs): writes
 * <agent>/fake-pi/<pid>.ctl with tmp + mv. ops: one op object or an array of them.
 */
export function control(pid, ops) {
  const file = path.join(AGENT, "fake-pi", `${pid}.ctl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(ops));
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * A fake pi window for the native forge screens: started with a prompt, then sent `more` prompts
 * (each answered before the next), so it has checkpoints to rewind and diff. `env` reaches only
 * this window (e.g. FAKE_PI_AREAS=core for an older forge build). Returns {name, pane, pid}.
 */
export async function forgeWindow(name, prompts, env = {}) {
  const [first, ...more] = prompts;
  const cwd = path.join(WORK, "api");
  fs.mkdirSync(cwd, { recursive: true });
  const w = newWindow(name, cwd, ["pi", "--model", "fake/fake-1", "--", first], env);
  const messages = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(PROCS, `${w.pid}.json`), "utf8")).messages;
    } catch {
      return 0;
    }
  };
  await waitFor(() => messages() >= 2 && procState(w.pid) === "idle", 15_000, `${name} reply`);
  for (const [i, text] of more.entries()) {
    tmux("send-keys", "-t", w.pane, "-l", text);
    tmux("send-keys", "-t", w.pane, "Enter");
    await waitFor(
      () => messages() >= 4 + i * 2 && procState(w.pid) === "idle",
      15_000,
      `${name} reply ${i + 2}`,
    );
  }
  return w;
}

/** Ends a forge window without a trace on the dashboard: no ended record, no live record. */
export async function killWindow(w) {
  try {
    tmux("kill-pane", "-t", w.pane);
  } catch {
    // already gone
  }
  try {
    process.kill(w.pid, "SIGTERM");
  } catch {
    // already gone
  }
  await sleep(500);
  fs.rmSync(path.join(PROCS, `${w.pid}.json`), { force: true });
  fs.rmSync(path.join(AGENT, "forge", "remote", String(w.pid)), { recursive: true, force: true });
}

/** The fake pi's published remote state (state.json), or undefined. */
export function remoteState(pid) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(AGENT, "forge", "remote", String(pid), "state.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
}

export function procState(pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROCS, `${pid}.json`), "utf8")).state;
  } catch {
    return undefined;
  }
}

/**
 * forge with the remote channel: the remote-channel worktree (never the live ~/.pi/forge, which
 * another session edits). PIM_E2E_FORGE overrides it.
 */
export const FORGE_DIR =
  process.env.PIM_E2E_FORGE ||
  path.join(os.homedir(), "projects", "pi-mobile-work", "forge-remote");

/**
 * Test-only rig extension: `/pimrig` opens a select then an input and logs what they returned;
 * `/pimbg` starts a real background shell through forge's own job runner (guards' startJob, as
 * bash_background does), so /tasks has a live shell offline, without a model turn.
 */
const rigSource = (forgeDir) => `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { jobsDir, startJob } from "${forgeDir}/extensions/_lib/guards/bgjobs.ts";
export default function (pi) {
  const log = (line) =>
    appendFileSync(join(process.env.PI_CODING_AGENT_DIR, "pimrig.log"), line + "\\n");
  pi.registerCommand("pimrig", {
    description: "pi-mobile test rig: a select and an input",
    handler: async (_args, ctx) => {
      const color = await ctx.ui.select("RIG pick a color", ["red", "green", "blue"]);
      log("picked=" + String(color));
      const name = await ctx.ui.input("RIG name it", "a name");
      log("input=" + String(name));
    },
  });
  pi.registerCommand("pimbg", {
    description: "pi-mobile test rig: a background shell",
    handler: async (_args, ctx) => {
      const session = ctx.sessionManager.getSessionId();
      const dir = jobsDir(join(process.env.PI_CODING_AGENT_DIR, "forge", "bg"), session);
      const meta = startJob({
        dir,
        name: "ticker",
        command: "i=0; while true; do i=$((i+1)); echo tick $i; sleep 1; done",
        cwd: ctx.cwd,
        shell: "/bin/sh",
        shellArgs: ["-c"],
        ownerSessionId: session,
      });
      log("bg=" + String(meta.name) + " log=" + String(meta.logPath));
    },
  });
}
`;

/** The real pi's offline models (sandbox models.json): one that thinks, one that does not. */
const REAL_MODELS = {
  providers: {
    fake: {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      apiKey: "none",
      models: [
        {
          id: "tiny",
          name: "Fake Tiny",
          reasoning: true,
          input: ["text"],
          contextWindow: 100000,
          maxTokens: 4096,
        },
        {
          id: "plain",
          name: "Fake Plain",
          reasoning: false,
          input: ["text"],
          contextWindow: 50000,
          maxTokens: 4096,
        },
      ],
    },
  },
};

/** The rig's log lines (real pi + forge worktree run). */
export function rigLog() {
  try {
    return fs.readFileSync(path.join(AGENT, "pimrig.log"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Real pi + forge (the remote-channel worktree) in the sandbox agent dir, without a prompt. */
function startRealPi() {
  const realPi = run("sh", ["-c", "command -v pi"], { env: process.env }).trim();
  const realNodeDir = path.dirname(process.execPath);
  if (!fs.existsSync(path.join(FORGE_DIR, "extensions", "remote.ts")))
    throw new Error(`no remote-channel forge at ${FORGE_DIR} (set PIM_E2E_FORGE)`);
  const rig = path.join(ROOT, "pimrig.ts");
  fs.writeFileSync(rig, rigSource(FORGE_DIR));
  // An offline model (nothing listens on :9), so /model, /btw and the footer have something real
  // to show; no auth is copied and PI_OFFLINE keeps pi from reaching the network.
  fs.writeFileSync(path.join(AGENT, "models.json"), JSON.stringify(REAL_MODELS, null, 2));
  // Two MCP servers that cannot start: `/mcp reconnect` then asks which one (pi's select).
  fs.writeFileSync(
    path.join(AGENT, "mcp.json"),
    JSON.stringify({ mcpServers: { github: { command: "false" }, linear: { command: "false" } } }),
  );
  const settings = {
    packages: [FORGE_DIR],
    extensions: [rig],
    defaultProvider: "fake",
    defaultModel: "tiny",
    defaultThinkingLevel: "medium",
    theme: "claude",
    tuiMode: "fullscreen",
    quietStartup: true,
    collapseChangelog: true,
    defaultProjectTrust: "always",
    lastChangelogVersion: "1.0.0",
  };
  fs.writeFileSync(path.join(AGENT, "settings.json"), JSON.stringify(settings, null, 2));
  return newWindow("pi-real", path.join(WORK, "api"), [realPi], {
    PATH: `${realNodeDir}:${BIN}:/usr/bin:/bin`,
    PI_OFFLINE: "1",
  });
}

// ---------------------------------------------------------------------------
// up / down / status
// ---------------------------------------------------------------------------

export async function up() {
  if (fs.existsSync(ROOT)) await down();
  for (const dir of [SSHD_DIR, HOME, BIN, WORK, PROCS])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(TMUX_TMPDIR, { mode: 0o700, recursive: true });
  run("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "pim-e2e-host-a",
    "-f",
    path.join(SSHD_DIR, "host_ed25519_a"),
  ]);
  run("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "pim-e2e-harness",
    "-f",
    path.join(SSHD_DIR, "harness_ed25519"),
  ]);
  fs.writeFileSync(
    path.join(SSHD_DIR, "authorized_keys"),
    fs.readFileSync(path.join(SSHD_DIR, "harness_ed25519.pub")),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(HOME, ".profile"),
    [
      `export PI_CODING_AGENT_DIR='${AGENT}'`,
      `export TMUX_TMPDIR='${TMUX_TMPDIR}'`,
      "export PI_SKIP_VERSION_CHECK=1",
      "export LANG=C.UTF-8",
      `export PATH='${BIN}':/usr/local/bin:/usr/bin:/bin`,
      "",
    ].join("\n"),
  );
  fs.chmodSync(FAKE_PI, 0o755);
  fs.symlinkSync(FAKE_PI, path.join(BIN, "pi"));
  fs.symlinkSync(process.execPath, path.join(BIN, "node"));
  writeState({
    root: ROOT,
    port: PORT,
    socket: SOCKET,
    agentDir: AGENT,
    hostKey: path.join(SSHD_DIR, "host_ed25519_a"),
  });
  await sshdStart();
  const windows = await seed();
  verifyProbeLandsInSandbox();
  log("sandbox up", JSON.stringify({ port: PORT, socket: SOCKET, windows }));
}

/** Runs the same login-shell env lookup the app's probe does, over the isolated sshd. */
export function verifyProbeLandsInSandbox() {
  const out = ssh(
    `$SHELL -l -c 'echo AGENT=$PI_CODING_AGENT_DIR; echo TMPDIR=$TMUX_TMPDIR; echo PI=$(readlink -f "$(command -v pi)")'`,
  );
  const ok =
    out.includes(`AGENT=${AGENT}`) &&
    out.includes(`TMPDIR=${TMUX_TMPDIR}`) &&
    out.includes(`PI=${fs.realpathSync(FAKE_PI)}`);
  if (!ok) throw new Error(`login shell over the isolated sshd is not sandboxed:\n${out}`);
  log("probe environment is sandboxed (agent dir, tmux tmpdir, fake pi)");
}

export function ssh(command) {
  return run("ssh", [
    "-F",
    "/dev/null",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-i",
    path.join(SSHD_DIR, "harness_ed25519"),
    "-p",
    String(PORT),
    `${USER}@127.0.0.1`,
    command,
  ]);
}

/**
 * Starts the password gateway (scripts/e2e-password-gateway.mjs) on PORT+1 with the current
 * sshd host key, as a detached process. Returns { port, password, logFile }.
 */
export async function gatewayStart() {
  const port = PORT + 1;
  const password = `pim-${Math.random().toString(36).slice(2, 10)}`;
  const logFile = path.join(ROOT, "gateway-auth.log");
  const outFd = fs.openSync(path.join(ROOT, "gateway.out"), "a");
  const child = spawn(process.execPath, [path.join(HERE, "e2e-password-gateway.mjs")], {
    cwd: APP,
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: {
      ...process.env,
      PIM_GW_HOST_KEY: hostKeyPath(),
      PIM_GW_HOME: HOME,
      PIM_GW_USER: USER,
      PIM_GW_PASSWORD: password,
      PIM_GW_PORT: String(port),
      PIM_GW_LOG: logFile,
    },
  });
  child.unref();
  fs.closeSync(outFd);
  writeState({ gatewayPid: child.pid });
  await waitFor(
    () => fs.readFileSync(path.join(ROOT, "gateway.out"), "utf8").includes("listening"),
    10_000,
    "password gateway to listen",
  );
  log(`password gateway pid ${child.pid} on 127.0.0.1:${port}`);
  return { port, password, logFile };
}

export function gatewayStop() {
  const pid = readState().gatewayPid;
  if (pid && pidAlive(pid)) process.kill(pid, "SIGTERM");
  writeState({ gatewayPid: null });
}

export async function down() {
  try {
    gatewayStop();
  } catch {
    // no state
  }
  await sshdStop().catch(() => undefined);
  try {
    tmux("kill-server");
  } catch {
    // no server
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  log("sandbox removed");
}

export function sessionsList() {
  try {
    return tmux("list-sessions", "-F", "#{session_name} #{session_group} #{session_attached}")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function events(pid) {
  try {
    return fs
      .readFileSync(path.join(AGENT, "fake-pi", `${pid}.log`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const COMMANDS = {
  up,
  down,
  "sshd-start": sshdStart,
  "sshd-stop": sshdStop,
  "hostkey-rotate": hostkeyRotate,
  "hostkey-restore": hostkeyRestore,
  authorize: (line) => authorize(line),
  status: () =>
    console.log(JSON.stringify({ ...readState(), tmuxSessions: sessionsList() }, null, 2)),
  events: (name) =>
    console.log(
      events(readState().windows?.[name]?.pid)
        .map((e) => JSON.stringify(e))
        .join("\n"),
    ),
  journey: async (...args) => (await import("./e2e-journey.mjs")).journey(args),
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`usage: e2e-emulator.mjs ${Object.keys(COMMANDS).join("|")}`);
    process.exit(2);
  }
  // Not a top-level await: `journey` imports e2e-journey.mjs, which imports this module back; a
  // pending top-level await here would leave that import waiting forever.
  Promise.resolve()
    .then(() => fn(...args))
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    });
}

export {
  ROOT,
  PORT,
  SOCKET,
  AGENT,
  PROCS,
  HOME,
  SSHD_DIR,
  USER,
  readState,
  writeState,
  waitFor,
  sleep,
  log,
};
