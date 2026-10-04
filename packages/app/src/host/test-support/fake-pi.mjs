#!/usr/bin/env node
// A stand-in for interactive pi + forge's sessions registry, for host integration tests only.
// It writes <agentDir>/forge/procs/<pid>.json like forge (same key order), a session .jsonl like
// pi, puts the tty in raw mode with bracketed paste on, and logs every input byte to
// <agentDir>/fake-pi/<pid>.log (one JSON event per line). Synthetic: no real session content.
//
// Input: a bracketed paste then CR submits the paste; a typed line then CR submits it; a lone
// ESC aborts (state -> idle). Commands: "/quit" ends (ended record, live file removed),
// "/work" stays working until ESC, "/wait" opens a dialog (state waiting) until SIGUSR1.
//
// Remote channel v1 (forge's side of ~/projects/pi-mobile-work/remote-channel.md), unless
// FAKE_PI_REMOTE=0: the record says "remote": 1; <agentDir>/forge/remote/<pid>/state.json
// publishes prompt/questions/commands/footer; the inbox is drained every 150 ms and each action
// gets results/<nonce>.json (ok, stale, expired, invalid, refused, unknown-action). Answers are
// logged ({kind:"remote"}) and appended to the session as displayed custom messages.
// Tests drive it through <agentDir>/fake-pi/<pid>.ctl (JSON op or array of ops, write tmp + mv):
//   {op:"prompt", kind, title, message?, options?, placeholder?, prefill?}  open a dialog
//   {op:"ask", blocking?, items:[{question, header?, multiSelect?, options:[{label,description?}]}]}
//   {op:"desktop-first", count: n|"always"|0}  the desktop answers first (the app's answer is stale)
//   {op:"desktop-answer"}  the desktop answers the open dialog now;  {op:"clear"}
// SIGUSR2 opens a select dialog (FAKE_PI_WAIT_TITLE, FAKE_PI_WAIT_OPTIONS "A|B"); SIGUSR1 cancels it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const argv = process.argv.slice(2);
let model;
let thinking;
let sessionArg;
let prompt;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--model") model = argv[++i];
  else if (a === "--thinking") thinking = argv[++i];
  else if (a === "--session") sessionArg = argv[++i];
  else if (a === "--") {
    prompt = argv.slice(i + 1).join(" ");
    break;
  }
}

const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const procs = path.join(agentDir, "forge", "procs");
const logDir = path.join(agentDir, "fake-pi");
fs.mkdirSync(path.join(procs, "ended"), { recursive: true, mode: 0o700 });
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `${process.pid}.log`);
const log = (event) =>
  fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...event })}\n`);

const hex8 = () =>
  Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
const uuid = () =>
  `${hex8()}-${hex8().slice(0, 4)}-7${hex8().slice(0, 3)}-8${hex8().slice(0, 3)}-${hex8()}${hex8().slice(0, 4)}`;

let sessionId;
let sessionFile;
let leaf = null;
let messages = 0;
let firstPrompt = null;
let resumedLastText = null;
/** entry id -> parentId, and the user prompts in order (rewind / checkpoints). */
const parents = new Map();
let userEntries = [];
let sessionName = null;
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}
const firstLineOf = (content) => textOf(content).trim().split("\n")[0];
if (sessionArg) {
  sessionFile = path.resolve(sessionArg);
  const lines = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    const e = JSON.parse(line);
    if (e.type === "session") sessionId = e.id;
    else if (e.id) leaf = e.id;
    if (e.id) parents.set(e.id, e.parentId ?? null);
    if (e.type === "message" && e.message?.role === "user")
      userEntries.push({
        id: e.id,
        text: firstLineOf(e.message.content),
        at: Date.parse(e.timestamp) || Date.now(),
      });
    if (e.type === "message") {
      messages++;
      if (!firstPrompt && e.message?.role === "user")
        firstPrompt = textOf(e.message.content).split("\n")[0] || null;
      if (e.message?.role === "assistant" && firstLineOf(e.message.content))
        resumedLastText = firstLineOf(e.message.content).slice(0, 200);
    }
  }
  try {
    fs.unlinkSync(path.join(procs, "ended", `${sessionId}.json`));
  } catch {}
} else {
  sessionId = uuid();
  const dir = path.join(
    agentDir,
    "sessions",
    `--${process
      .cwd()
      .replace(/^\//, "")
      .replace(/[/\\:]/g, "-")}--`,
  );
  fs.mkdirSync(dir, { recursive: true });
  sessionFile = path.join(
    dir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
  );
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
  );
}

function append(entry) {
  const full = { ...entry, id: hex8(), parentId: leaf, timestamp: new Date().toISOString() };
  fs.appendFileSync(sessionFile, `${JSON.stringify(full)}\n`);
  parents.set(full.id, full.parentId);
  leaf = full.id;
  if (entry.type === "message" && entry.message?.role === "user")
    userEntries.push({ id: full.id, text: firstLineOf(entry.message.content), at: Date.now() });
  return full;
}

let procStart = "";
try {
  procStart =
    fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ").pop().split(" ")[19] ?? "";
} catch {}
let bootId = "";
try {
  bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
} catch {}
const tmuxSocket = (process.env.TMUX || "").split(",")[0];
const tmuxPane = process.env.TMUX_PANE || "";
const startedAt = Date.now();
let state = "idle";
let stateSince = startedAt;
let waitingFor = null;
let lastRun = resumedLastText
  ? { startedAt: Date.now() - 1000, endedAt: Date.now(), outcome: "completed", error: null }
  : null;
let lastText = resumedLastText;
const WAIT_TITLE = process.env.FAKE_PI_WAIT_TITLE || "Allow bash?";
const WAIT_OPTIONS = (process.env.FAKE_PI_WAIT_OPTIONS || "Allow|Deny").split("|").filter(Boolean);
const REMOTE = process.env.FAKE_PI_REMOTE !== "0";
/** How long a /btw answer takes (the emulator journey lengthens it to capture the pending state). */
const BTW_MS = Number(process.env.FAKE_PI_BTW_MS || 1500);
const remoteRoot = path.join(agentDir, "forge", "remote", String(process.pid));
const inboxDir = path.join(remoteRoot, "inbox");
const resultsDir = path.join(remoteRoot, "results");
const controlFile = path.join(logDir, `${process.pid}.ctl`);
// forge's `/` menu rows (menuRows()), a realistic subset.
const COMMANDS = [
  { name: "answer", description: "Answer pi's open questions" },
  { name: "branch", description: "Branch this session into a new one" },
  { name: "btw", description: "Ask a side question without derailing the session" },
  { name: "changelog", description: "What's new in pi" },
  { name: "clear", description: "Start a new session" },
  { name: "compact", description: "Compact the context to free up space" },
  { name: "cost", description: "Session cost and token usage" },
  { name: "diff", description: "Show the changes since a checkpoint" },
  { name: "export", description: "Export the conversation as Markdown" },
  { name: "mcp", description: "Manage MCP servers" },
  { name: "model", description: "Pick the model and thinking level" },
  { name: "pause", description: "Pause, then wake the agent later" },
  { name: "rename", description: "Rename this session" },
  { name: "restore", description: "Restore the files of a checkpoint" },
  { name: "rewind", description: "Rewind the conversation and code" },
  { name: "side", description: "Open a side conversation" },
  { name: "sync", description: "Sync pi's setup with its repo" },
  { name: "tasks", description: "Background tasks, agents and workflows" },
  { name: "thinking", description: "Set the thinking level" },
  { name: "usage", description: "Plan usage and limits" },
];
// Rows whose screens are TUI-only views: command.run refuses them ("use the specific action").
const TUI_VIEWS = new Set([
  "answer",
  "btw",
  "changelog",
  "cost",
  "diff",
  "model",
  "rewind",
  "side",
  "tasks",
  "usage",
  "pause",
  "sync",
  "restore",
  "thinking",
]);
let remoteReady = false;
let rev = 0;
let seq = 0;
/** The open dialog (contract `prompt`), or null. */
let openDialog = null;
/** Open ask_user items (contract `questions`). */
let asks = [];
let desktopFirst =
  process.env.FAKE_PI_DESKTOP_FIRST === "always"
    ? Number.POSITIVE_INFINITY
    : Number(process.env.FAKE_PI_DESKTOP_FIRST || 0);
const results = new Map();
const modelInfo = model
  ? { provider: model.split("/")[0], id: model.split("/").slice(1).join("/") || model }
  : { provider: "fake", id: "fake-1" };
if (thinking) modelInfo.thinking = thinking;
let thinkingLevel = thinking ?? "medium";

function record() {
  return {
    v: 1,
    pid: process.pid,
    procStart,
    bootId,
    host: os.hostname(),
    piVersion: "0.0.0-fake",
    startedAt,
    updatedAt: Date.now(),
    cwd: process.cwd(),
    tty: null,
    tmux: tmuxSocket && tmuxPane ? { socket: tmuxSocket, pane: tmuxPane } : null,
    sessionId,
    sessionFile,
    name: sessionName,
    firstPrompt,
    messages,
    model: modelInfo,
    state,
    stateSince,
    waitingFor,
    activity: state === "working" ? "bash: sleep 1" : null,
    agents: { running: 0, workflows: 0, workflowName: null },
    lastRun,
    lastText,
    question: null,
    ...(asks.length > 0
      ? {
          pendingQuestions: asks.length,
          pendingTitle: asks[0].items[0].question,
          pendingSince: asks[0].askedAt,
        }
      : {}),
    ...(REMOTE ? { remote: 1 } : {}),
  };
}
const liveFile = path.join(procs, `${process.pid}.json`);
function writeRecord() {
  const tmp = `${liveFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(record())}\n`, { mode: 0o600 });
  fs.renameSync(tmp, liveFile);
  writeRemoteState();
}

// ---------- remote channel ----------

// ---------- forge's native-screen areas (the app's /rewind, /tasks, /model, … screens) ----------
// FAKE_PI_AREAS=core: only the Wave 11 areas (prompt, questions, commands, footer); every other
// action is unknown-action, as an older forge build answers (the app says "Update forge").
const AREAS_CORE = process.env.FAKE_PI_AREAS === "core";
const forgeDir = path.join(logDir, `${process.pid}.forge`);
const MCP_OPTIONS = ["github", "linear"];
const MODELS = [
  { ref: "anthropic/claude-opus-5-5", name: "Opus 5.5" },
  { ref: "anthropic/claude-sonnet-5", name: "Sonnet 5" },
  { ref: "openai/gpt-6", name: "GPT 6" },
  { ref: "openai/gpt-6-mini", name: "GPT 6 mini" },
  { ref: "google/gemini-3-pro", name: "Gemini 3 Pro" },
  { ref: "fake/fake-1", name: "Fake 1" },
];
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const modelName = (ref) => MODELS.find((m) => m.ref === ref)?.name ?? "";
const pins = {
  pinned: ["anthropic/claude-opus-5-5", "openai/gpt-6"],
  recent: ["google/gemini-3-pro"],
};
let wake = null;
let side = null;
let btwLast = null;
/** forge's /btw panel (state `btw`, v1.2): {open, pending, question, error} or null. */
let btw = null;
const restored = [];

function forgeFile(name, text) {
  fs.mkdirSync(forgeDir, { recursive: true });
  const file = path.join(forgeDir, name);
  if (text !== undefined) fs.writeFileSync(file, text);
  return file;
}
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
const msg = (id, parentId, role, text, extra = {}) => ({
  type: "message",
  id,
  parentId,
  timestamp: new Date().toISOString(),
  message: { role, content: [{ type: "text", text }], timestamp: Date.now(), ...extra },
});
function appendTo(file, role, text) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  const id = hex8();
  fs.appendFileSync(file, `${JSON.stringify(msg(id, last.id ?? null, role, text))}\n`);
}
function sessionFileFor(name, id, entries) {
  const header = {
    type: "session",
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  return forgeFile(name, jsonl([header, ...entries]));
}

let tasks = null;
function seedTasks() {
  if (tasks) return tasks;
  const shellLog = forgeFile(
    "test-watch.log",
    [
      "$ npm test -- --watch",
      "",
      " RUN  v4.1.7 /work/api",
      "",
      " ✓ src/limiter.test.ts (12 tests) 41ms",
      " ✓ src/bucket.test.ts (8 tests) 17ms",
      " × src/routes.test.ts > rejects a burst over the limit",
      "   → expected 429, received 200",
      "",
    ].join("\n"),
  );
  const agent = sessionFileFor("agent-review.jsonl", uuid(), [
    msg(
      "a1",
      null,
      "user",
      "Review the token bucket refactor in src/limiter.ts for race conditions.",
    ),
    msg(
      "a2",
      "a1",
      "assistant",
      "Two refill paths can run at once: `take()` refills before checking, and the timer refills too. Guard the refill with the same lock, or refill only in `take()`.",
      { stopReason: "stop" },
    ),
  ]);
  tasks = [
    {
      owner: "main",
      key: "sh-1",
      kind: "shell",
      name: "npm test -- --watch",
      status: "running",
      detail: null,
      canStop: true,
      canResume: false,
      sessionFile: null,
      logPath: shellLog,
      runDir: null,
    },
    {
      owner: "main",
      key: "ag-review",
      kind: "agent",
      name: "review: token bucket",
      status: "done",
      detail: null,
      canStop: false,
      canResume: true,
      sessionFile: agent,
      logPath: null,
      runDir: null,
    },
    {
      owner: "main",
      key: "wf-sweep",
      kind: "workflow",
      name: "sweep · 3 agents",
      status: "interrupted",
      detail: "2 of 3 agents finished",
      canStop: false,
      canResume: true,
      sessionFile: null,
      logPath: null,
      runDir: path.join(forgeDir, "runs", "20261002T101204-sweep"),
    },
  ];
  // The watcher keeps writing while it runs.
  setInterval(() => {
    const shell = tasks.find((t) => t.key === "sh-1");
    if (shell?.status === "running")
      fs.appendFileSync(
        shellLog,
        ` ✓ src/limiter.test.ts (12 tests) ${30 + Math.floor(Math.random() * 20)}ms\n`,
      );
  }, 2000).unref();
  return tasks;
}

/** Checkpoints: one per prompt on this branch (n from 1), with made-up change counts. */
function checkpoints() {
  return userEntries.map((e, i) => ({
    n: i + 1,
    entryId: e.id,
    label: e.text.slice(0, 80),
    at: e.at,
    files: i === 0 ? 0 : (i % 3) + 1,
    added: i === 0 ? 0 : 7 * i + 3,
    removed: i === 0 ? 0 : 2 * i,
  }));
}

function forgeAreas() {
  if (AREAS_CORE) return {};
  return {
    wake,
    side: side ? { open: true, working: side.working, sessionFile: side.file } : null,
    tasks: seedTasks(),
    checkpoints: checkpoints(),
    pins,
    btw,
  };
}

function patchFor(n) {
  return [
    "diff --git a/src/limiter.ts b/src/limiter.ts",
    "--- a/src/limiter.ts",
    "+++ b/src/limiter.ts",
    "@@ -1,9 +1,14 @@",
    " import { clock } from './clock';",
    "-export function limit(req: Request) {",
    "-  return counter.hit(req.ip) > MAX;",
    "+export class TokenBucket {",
    "+  private tokens = CAPACITY;",
    "+  private last = clock.now();",
    "+  take(): boolean {",
    "+    this.refill();",
    "+    if (this.tokens < 1) return false;",
    "+    this.tokens -= 1;",
    "+    return true;",
    "+  }",
    " }",
    `diff --git a/README.md b/README.md`,
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -12,3 +12,4 @@",
    " ## Rate limits",
    `-Requests are counted per IP (checkpoint ${n}).`,
    "+Each IP gets a token bucket of 20 requests, refilled at 5 per second, so a long horizontal line in a diff has to scroll sideways on a phone.",
    "",
  ].join("\n");
}

const ok = (data = null) => ({ code: "ok", data });
const bad = (message) => ({ code: "invalid", message });
const argText = (v) => (typeof v === "string" ? v.trim() : "");

function answerFor(question) {
  if (/bucket/i.test(question))
    return "A token bucket holds up to N tokens and refills at a steady rate; each request takes one, so short bursts pass and sustained floods wait.";
  return `Short answer: ${question.replace(/\?$/, "")} — yes, and nothing in the session changes.`;
}

function openSide(seed) {
  const id = uuid();
  side = { file: sessionFileFor(`side-${id}.jsonl`, id, []), working: false };
  if (seed) sideTurn(seed);
}
function sideTurn(question) {
  appendTo(side.file, "user", question);
  side.working = true;
  const current = side;
  setTimeout(() => {
    if (side !== current) return;
    appendTo(current.file, "assistant", `side: ${answerFor(question)}`);
    current.working = false;
    writeRecord();
  }, 400).unref();
}

function forgeAct(action, args) {
  if (AREAS_CORE) return { code: "unknown-action", message: `${action} is not implemented` };
  const res = forgeRun(action, args);
  if (res.code !== "unknown-action")
    log({ kind: "remote", action, by: "app", args, code: res.code });
  writeRecord();
  return res;
}

/** The first group that knows the action answers it. */
function forgeRun(action, args) {
  for (const run of [runCheckpoints, runTasks, runSide, runModels, runWake, runSession]) {
    const res = run(action, args);
    if (res !== UNKNOWN) return res;
  }
  return { code: "unknown-action", message: `${action} is not implemented` };
}

const UNKNOWN = { code: "unknown-action" };

/** forge's rewind.preview shape (checkpoints.ts remotePreview) for the prompt at index i. */
function rewindPreview(i) {
  const after = checkpoints().slice(i);
  const sum = (k) => after.reduce((a, c) => a + c[k], 0);
  const files = Math.min(9, sum("files"));
  const names = ["src/limiter.ts", "src/limiter.test.ts", "README.md", "src/routes.ts"];
  const changed = Array.from({ length: files }, (_, k) => names[k % names.length]);
  // forge's shape (checkpoints.ts remotePreview): the list row's words, the confirm sentence.
  const counts = [
    sum("added") ? `+${sum("added")}` : "",
    sum("removed") ? `-${sum("removed")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const what = files === 1 ? "1 file changed" : `${files} files changed`;
  const code =
    files > 0
      ? {
          files: changed,
          added: sum("removed"),
          removed: sum("added"),
          counted: true,
          sentence: `The code will be restored ${counts} in ${changed[0].split("/").pop()} and ${files - 1} other files.`,
        }
      : null;
  return {
    entryId: userEntries[i].id,
    quote: userEntries[i].text,
    at: userEntries[i].at,
    heading: code ? "code" : "conversation",
    row: code ? `${what}${counts ? ` ${counts}` : ""}` : "No code changes",
    code,
    modes: code ? ["both", "conversation", "code"] : ["conversation"],
    warnings: [],
  };
}

function runCheckpoints(action, args) {
  switch (action) {
    case "rewind.preview": {
      const i = userEntries.findIndex((e) => e.id === args.entryId);
      if (i < 0) return { code: "stale", message: "that prompt is not on this branch" };
      return ok(rewindPreview(i));
    }
    case "rewind.apply": {
      const i = userEntries.findIndex((e) => e.id === args.entryId);
      if (i < 0) return { code: "stale", message: "that prompt is not on this branch" };
      if (!["both", "conversation", "code"].includes(args.mode)) return bad("bad mode");
      const target = userEntries[i];
      if (args.mode !== "code") {
        // The branch goes back to before the prompt: the next entry hangs off its parent.
        leaf = parents.get(target.id) ?? null;
        userEntries = userEntries.slice(0, i);
      }
      const report =
        args.mode === "conversation"
          ? "Navigated to selected point"
          : `Code restored to before: ${target.text}`;
      notice(report);
      return { code: "ok", data: null, message: report };
    }
    case "checkpoint.diff": {
      const n = Number(args.n);
      if (!checkpoints().some((c) => c.n === n))
        return { code: "stale", message: "no such checkpoint" };
      return ok({ patch: patchFor(n), truncated: false });
    }
    case "checkpoint.restore": {
      const n = Number(args.n);
      if (!checkpoints().some((c) => c.n === n))
        return { code: "stale", message: "no such checkpoint" };
      restored.push(n);
      notice(`Restored to checkpoint ${n}`);
      return {
        code: "ok",
        data: null,
        message: `Restored to checkpoint ${n} · /restore ${n + 100} undoes this.`,
      };
    }
    default:
      return UNKNOWN;
  }
}

function runTasks(action, args) {
  switch (action) {
    case "task.stop": {
      const task = seedTasks().find((t) => t.owner === args.owner && t.key === args.key);
      if (!task) return { code: "stale", message: "no such task" };
      if (!task.canStop)
        return { code: "refused", message: "not running", data: { reason: "gate" } };
      Object.assign(task, { status: "stopped", canStop: false });
      return ok();
    }
    case "task.resume": {
      const task = seedTasks().find(
        (t) => t.key === args.runId || (t.runDir && path.basename(t.runDir) === args.runId),
      );
      if (!task) return { code: "stale", message: "no such run" };
      Object.assign(task, { status: "running", canResume: false, canStop: true });
      return ok();
    }
    case "task.tail": {
      const task = seedTasks().find((t) => t.owner === args.owner && t.key === args.key);
      if (!task) return { code: "stale", message: "no such task" };
      // forge tails shells only (v1.2); agents and runs: read their sessionFile.
      if (task.kind !== "shell" || !task.logPath) return bad("task.tail works for shells only");
      const all = fs.readFileSync(task.logPath, "utf8");
      const bytes = Number(args.bytes) > 0 ? Number(args.bytes) : 16384;
      return ok({ text: all.slice(-bytes) });
    }
    case "agent.send": {
      const task = seedTasks().find((t) => t.key === args.key && t.kind === "agent");
      if (!task) return { code: "stale", message: "no such agent" };
      if (!argText(args.text) || !["steer", "followUp"].includes(args.mode))
        return bad("text and mode");
      appendTo(task.sessionFile, "user", argText(args.text));
      setTimeout(() => {
        appendTo(task.sessionFile, "assistant", `agent: noted, ${argText(args.text).slice(0, 40)}`);
        writeRecord();
      }, 300).unref();
      return ok();
    }
    case "agent.resume": {
      const task = seedTasks().find((t) => t.key === args.key && t.kind === "agent");
      if (!task) return { code: "stale", message: "no such agent" };
      // v1.2: resuming starts a turn of the agent, so it carries the user's text.
      if (!argText(args.text))
        return bad("text must be text: a resumed agent starts with your message");
      appendTo(task.sessionFile, "user", argText(args.text));
      Object.assign(task, { status: "running", canResume: false, canStop: true });
      setTimeout(() => {
        appendTo(
          task.sessionFile,
          "assistant",
          `agent: resumed, ${argText(args.text).slice(0, 40)}`,
        );
        Object.assign(task, { status: "done", canResume: true, canStop: false });
        writeRecord();
      }, 600).unref();
      return ok();
    }
    default:
      return UNKNOWN;
  }
}

function runSide(action, args) {
  switch (action) {
    case "side.open":
      if (side) return { code: "refused", message: "the side is open", data: { reason: "gate" } };
      openSide(argText(args.text));
      return ok();
    case "side.send":
      if (!side) return { code: "stale", message: "the side is closed" };
      if (!argText(args.text)) return bad("text");
      sideTurn(argText(args.text));
      return ok();
    case "side.close":
      if (!side) return { code: "stale", message: "the side is closed" };
      side = null;
      return ok();
    case "btw.ask": {
      const question = argText(args.text);
      if (!question) return bad("text");
      if (btw?.pending)
        return {
          code: "refused",
          message: "a /btw answer is still coming",
          data: { reason: "busy" },
        };
      // forge opens the panel and answers in it (state `btw`); a failed answer writes no entry.
      btw = { open: true, pending: true, question, error: null };
      setTimeout(() => {
        if (/\bfail\b/i.test(question)) {
          btw = { open: true, pending: false, question, error: "Unknown provider: unknown" };
        } else {
          btwLast = { question, answer: answerFor(question) };
          append({ type: "custom", customType: "forge-btw", data: btwLast });
          btw = { open: true, pending: false, question, error: null };
        }
        writeRecord();
      }, BTW_MS).unref();
      return ok();
    }
    case "btw.close":
      if (!btw?.open) return { code: "stale", message: "no /btw panel is open" };
      btw = null;
      return ok();
    case "btw.fork":
      if (!btwLast) return bad("nothing to fork");
      btw = null;
      if (side) return { code: "refused", message: "the side is open", data: { reason: "gate" } };
      openSide("");
      appendTo(side.file, "user", btwLast.question);
      appendTo(side.file, "assistant", btwLast.answer);
      return ok();
    case "btw.clear":
      append({ type: "custom", customType: "forge-btw-clear", data: {} });
      btwLast = null;
      return ok();
    default:
      return UNKNOWN;
  }
}

function runModels(action, args) {
  switch (action) {
    case "models.list":
      return ok({
        available: MODELS,
        current: `${modelInfo.provider}/${modelInfo.id}`,
        thinking: { level: thinkingLevel, levels: [...THINKING] },
      });
    case "model.set": {
      if (!MODELS.some((m) => m.ref === args.ref)) return bad("not an available model");
      const [provider, ...rest] = args.ref.split("/");
      modelInfo.provider = provider;
      modelInfo.id = rest.join("/");
      pins.recent = [args.ref, ...pins.recent.filter((r) => r !== args.ref)]
        .filter((r) => !pins.pinned.includes(r))
        .slice(0, 10);
      return ok({ ref: args.ref, thinking: thinkingLevel });
    }
    case "thinking.set":
      if (!THINKING.has(args.level)) return bad("not a level");
      thinkingLevel = args.level;
      modelInfo.thinking = args.level;
      return ok({ level: thinkingLevel, levels: [...THINKING] });
    case "pin.toggle":
      if (typeof args.ref !== "string" || !args.ref) return bad("ref");
      if (pins.pinned.includes(args.ref)) pins.pinned = pins.pinned.filter((r) => r !== args.ref);
      else {
        pins.pinned = [...pins.pinned, args.ref];
        pins.recent = pins.recent.filter((r) => r !== args.ref);
      }
      return ok({ pinned: pins.pinned.includes(args.ref), pins });
    default:
      return UNKNOWN;
  }
}

function runWake(action, args) {
  switch (action) {
    case "usage.refresh": {
      // forge's shape (_lib/usage/remote.ts): plan names and meters only, never who signed in.
      const now = Date.now();
      return ok({
        at: now,
        accounts: [
          {
            id: "claude",
            name: "Claude",
            plan: "Max 20x",
            meters: [
              {
                label: "5-hour",
                ratio: 0.93,
                value: "93% left",
                detail: null,
                resetsAt: now + 5.5 * 3600_000,
              },
              {
                label: "Weekly",
                ratio: 0.65,
                value: "65% left",
                detail: null,
                resetsAt: now + (3 * 24 + 21) * 3600_000,
              },
            ],
            asOf: now,
            fetchedAt: now,
            problem: null,
            empty: null,
          },
          {
            id: "openrouter",
            name: "OpenRouter",
            plan: "Free tier",
            meters: [
              {
                label: "Credits",
                ratio: null,
                // forge's credits meter (_lib/usage/openrouter.ts): what is left, no detail.
                value: "$12.34 left",
                detail: null,
                resetsAt: null,
              },
            ],
            asOf: now,
            fetchedAt: now,
            problem: null,
            empty: null,
          },
        ],
      });
    }
    case "cost.read":
      // forge's shape (_lib/status-line/remote.ts costReadData): pi's Session Info in sections.
      return ok({
        sections: [
          {
            title: null,
            rows: [
              { label: "File", value: sessionFile, indent: false },
              { label: "ID", value: sessionId, indent: false },
            ],
          },
          {
            title: "Messages",
            rows: [
              { label: "User", value: `${Math.ceil(messages / 2)}`, indent: true },
              { label: "Assistant", value: `${Math.floor(messages / 2)}`, indent: true },
              { label: "Total", value: `${messages}`, indent: true },
            ],
          },
          {
            title: "Tokens",
            rows: [
              {
                label: "Input",
                value: `${(messages * 6000).toLocaleString("en-US")}`,
                indent: true,
              },
              {
                label: "Output",
                value: `${(messages * 900).toLocaleString("en-US")}`,
                indent: true,
              },
            ],
          },
          {
            title: "Cost",
            rows: [{ label: "Total", value: `$${(messages * 0.021).toFixed(3)}`, indent: true }],
          },
        ],
      });
    case "wake.set": {
      const reason = argText(args.reason) || null;
      let due;
      // forge (_lib/wake/remote.ts): a number `in` is seconds, clamped to 60 s - 24 h.
      if (typeof args.in === "number" && args.in > 0)
        due = Date.now() + Math.min(86_400, Math.max(60, Math.round(args.in))) * 1000;
      else if (typeof args.at === "number" && args.at > Date.now() - 60_000) due = args.at;
      else return bad("in must be a positive number of seconds, or at epoch ms");
      wake = { due, reason, missed: false };
      return ok();
    }
    case "wake.cancel":
      if (!wake) return { code: "stale", message: "Nothing scheduled" };
      wake = null;
      return ok();
    case "export.run": {
      const want = argText(args.path);
      const file = want
        ? path.resolve(process.cwd(), want)
        : path.join(process.cwd(), `${sessionId.slice(0, 8)}-session.md`);
      if (!file.endsWith(".md"))
        return {
          code: "refused",
          message: "/export writes Markdown · use a .md name",
          data: { reason: "gate" },
        };
      if (fs.existsSync(file) && args.overwrite !== true)
        return {
          code: "refused",
          message: `Not exported: ${path.basename(file)} exists · use another name (or send overwrite: true)`,
          data: { reason: "exists" },
        };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `# ${sessionName ?? firstPrompt ?? "Session"}\n`);
      notice(`Session exported to: ${file}`);
      return ok({ path: file });
    }
    default:
      return UNKNOWN;
  }
}

function runSession(action, args) {
  switch (action) {
    case "session.rename":
      if (!argText(args.name)) return bad("name");
      sessionName = argText(args.name).slice(0, 200);
      return ok();
    case "session.branch":
    case "session.clear": {
      const keep =
        action === "session.branch"
          ? fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).slice(1)
          : [];
      const oldId = sessionId;
      sessionId = uuid();
      sessionFile = sessionFile.replace(oldId, sessionId);
      if (sessionFile.indexOf(sessionId) < 0)
        sessionFile = path.join(path.dirname(sessionFile), `${sessionId}.jsonl`);
      fs.writeFileSync(
        sessionFile,
        jsonl([
          {
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd: process.cwd(),
          },
        ]) + keep.map((l) => `${l}\n`).join(""),
      );
      if (action === "session.clear") {
        leaf = null;
        userEntries = [];
        messages = 0;
        firstPrompt = null;
        lastText = null;
        lastRun = null;
        sessionName = null;
      } else sessionName = argText(args.name) || sessionName;
      return ok();
    }
    case "sync.status":
      return ok({
        text: "~/.pi/forge: master, up to date with origin\nsettings: in sync\nskills: 14 linked",
        level: "info",
      });
    case "sync.run":
      notice("Pulled 2 commits · setup ok · Reloaded");
      return ok({ done: true });
    case "changelog.read":
      return ok({
        markdown:
          "## 1.4.0\n\n- `/rewind` shows what each prompt changed.\n- The status line keeps the context when narrow.\n\n## 1.3.2\n\n- Fixed `/export` names with spaces.\n",
        truncated: false,
      });
    default:
      return { code: "unknown-action", message: `${action} is not implemented` };
  }
}

/** The context field's colour as forge's ramp gives it: warning from the warning line, error at the point. */
function toneFor(percent) {
  if (percent >= 83) return "error";
  return percent >= 62 ? "warning" : "normal";
}

/** forge's `footer` (v1.2, _lib/status-line/remote.ts footerState): what the desktop line shows. */
function footerState() {
  const percent = Math.min(100, messages * 3);
  const items = [];
  if (!AREAS_CORE) {
    const shells = seedTasks().filter((t) => t.kind === "shell" && t.status === "running").length;
    if (shells) items.push(shells === 1 ? "1 shell" : `${shells} shells`);
    if (wake) items.push(`◷ wakes in ${Math.max(1, Math.ceil((wake.due - Date.now()) / 60_000))}m`);
  }
  return {
    model: {
      provider: modelInfo.provider,
      id: modelInfo.id,
      name: modelName(`${modelInfo.provider}/${modelInfo.id}`),
      thinking: thinkingLevel,
    },
    contextPercent: percent,
    contextTokens: messages * 6000,
    contextWindow: 200000,
    cost: Math.round(messages * 0.021 * 10_000) / 10_000,
    compactAt: 83,
    compactionPaused: false,
    contextTone: toneFor(percent),
    items,
  };
}

function writeRemoteState() {
  if (!REMOTE || !remoteReady) return;
  rev++;
  const snapshot = {
    v: 1,
    pid: process.pid,
    sessionId,
    rev,
    updatedAt: Date.now(),
    view: openDialog ? "dialog" : "main",
    draft: draftLine.trim() !== "",
    input: { submit: true, maxBytes: 60 * 1024 },
    prompt: openDialog,
    questions: asks,
    footer: footerState(),
    commands: COMMANDS,
    ...forgeAreas(),
  };
  const file = path.join(remoteRoot, "state.json");
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function notice(text) {
  append({ type: "custom_message", customType: "fake-remote", content: text, display: true });
}

/** pi's state after a dialog or question changed: waiting while one blocks, else as it was. */
function settleWaiting() {
  const blocking = asks.find((q) => q.blocking);
  if (openDialog) setState("waiting", { kind: openDialog.kind, title: openDialog.title });
  else if (blocking) setState("waiting", { kind: "ask", title: blocking.items[0].question });
  else setState(state === "waiting" ? "idle" : state);
}

function openPromptDialog(spec = {}) {
  const kind = spec.kind || "select";
  let options = spec.options !== undefined ? spec.options : null;
  if (options === null && kind === "select") options = WAIT_OPTIONS;
  openDialog = {
    id: `p${++seq}-${hex8()}`,
    kind,
    title: spec.title ?? WAIT_TITLE,
    message: spec.message ?? null,
    options,
    placeholder: spec.placeholder ?? null,
    prefill: spec.prefill ?? null,
    answerable: kind !== "custom" && spec.answerable !== false,
    held: false,
    since: Date.now(),
  };
  log({ kind: "remote", op: "prompt.open", id: openDialog.id, promptKind: kind });
  settleWaiting();
}

function closePromptDialog(by, value, cancel = false) {
  const dialog = openDialog;
  if (!dialog) return;
  openDialog = null;
  log({
    kind: "remote",
    action: "prompt.respond",
    by,
    id: dialog.id,
    value: value ?? null,
    cancel,
  });
  notice(cancel ? `${dialog.title} → cancelled` : `${dialog.title} → ${value}`);
  settleWaiting();
}

/** The answer the desktop gives when it answers first. */
function desktopValue(dialog) {
  if (dialog.kind === "select") return dialog.options?.[0] ?? "";
  if (dialog.kind === "confirm") return dialog.options?.[0] ?? "Yes";
  return "typed on the desktop";
}

function addAsk(spec) {
  const question = {
    id: `q${++seq}-${hex8()}`,
    blocking: spec.blocking !== false,
    askedAt: Date.now(),
    status: "open",
    items: spec.items,
  };
  asks.push(question);
  log({ kind: "remote", op: "ask.open", id: question.id });
  settleWaiting();
}

function closeAsk(question, by, answers) {
  asks = asks.filter((q) => q !== question);
  log({
    kind: "remote",
    action: answers ? "ask.answer" : "ask.dismiss",
    by,
    id: question.id,
    answers: answers ?? null,
  });
  if (answers) {
    const lines = question.items.map((item, i) => {
      const a = answers[i];
      if (!a) return `${item.question} → (skipped)`;
      return `${item.question} → ${[...a.picked, ...(a.typed ? [a.typed] : [])].join(", ")}`;
    });
    notice(`Answers:\n${lines.join("\n")}`);
  } else notice(`Dismissed: ${question.items[0].question}`);
  settleWaiting();
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function respondPrompt(args) {
  if (!openDialog || args.id !== openDialog.id)
    return { code: "stale", message: "that dialog is closed" };
  if (desktopFirst > 0) {
    desktopFirst--;
    closePromptDialog("desktop", desktopValue(openDialog));
    return { code: "stale", message: "answered on the desktop first" };
  }
  if (!openDialog.answerable)
    return { code: "refused", message: "answer this dialog on the desktop" };
  if (args.cancel === true) {
    closePromptDialog("app", null, true);
    return { code: "ok" };
  }
  if (typeof args.value !== "string") return { code: "invalid", message: "value must be text" };
  const kind = openDialog.kind;
  if (kind === "select" || kind === "confirm") {
    const choices = openDialog.options ?? (kind === "confirm" ? ["Yes", "No"] : []);
    if (!choices.includes(args.value))
      return { code: "invalid", message: "not one of the options" };
  }
  closePromptDialog("app", args.value);
  return { code: "ok" };
}

function answerAsk(args) {
  const question = asks.find((q) => q.id === args.id);
  if (!question) return { code: "stale", message: "that question is closed" };
  if (desktopFirst > 0) {
    desktopFirst--;
    closeAsk(
      question,
      "desktop",
      question.items.map((item) => ({ picked: item.options.slice(0, 1).map((o) => o.label) })),
    );
    return { code: "stale", message: "answered on the desktop first" };
  }
  if (!Array.isArray(args.answers) || args.answers.length !== question.items.length)
    return { code: "invalid", message: "one answer per question" };
  const answers = [];
  for (const [i, raw] of args.answers.entries()) {
    if (raw === null) {
      answers.push(null);
      continue;
    }
    const item = question.items[i];
    if (!isObject(raw) || !Array.isArray(raw.picked))
      return { code: "invalid", message: "bad answer" };
    const labels = new Set(item.options.map((o) => o.label));
    if (raw.picked.some((l) => !labels.has(l)))
      return { code: "invalid", message: "not one of the options" };
    if (!item.multiSelect && raw.picked.length > 1) return { code: "invalid", message: "pick one" };
    const typed = typeof raw.typed === "string" && raw.typed.trim() ? raw.typed : undefined;
    if (raw.picked.length === 0 && !typed) answers.push(null);
    else answers.push(typed ? { picked: raw.picked, typed } : { picked: raw.picked });
  }
  if (answers.every((a) => a === null)) return { code: "invalid", message: "nothing answered" };
  closeAsk(question, "app", answers);
  return { code: "ok" };
}

function runCommand(args) {
  const line = typeof args.line === "string" ? args.line.trim() : "";
  const name = /^\/(\S+)/.exec(line)?.[1];
  if (!name || !COMMANDS.some((c) => c.name === name))
    return { code: "invalid", message: "not a command" };
  if (TUI_VIEWS.has(name) || ((name === "rename" || name === "mcp") && line === `/${name}`))
    return {
      code: "refused",
      message: `/${name} opens a terminal view: use its action`,
      data: { reason: "tui-only" },
    };
  if (openDialog)
    return {
      code: "refused",
      message: "a dialog or a panel has the terminal's input",
      data: { reason: "busy" },
    };
  if (name === "mcp") {
    // `/mcp reconnect` (or login/logout) asks which server with pi's own select (v1.2): the app
    // answers it like any dialog. `/mcp` alone is pi's manager, a terminal-only view (above).
    log({ kind: "remote", action: "command.run", by: "app", line });
    openPromptDialog({ kind: "select", title: "MCP server", options: MCP_OPTIONS });
    return { code: "ok" };
  }
  // forge's command.run prints nothing of its own: the command's own output is what shows.
  log({ kind: "remote", action: "command.run", by: "app", line });
  return { code: "ok" };
}

function submitInput(args) {
  if (
    typeof args.text !== "string" ||
    !args.text.trim() ||
    Buffer.byteLength(args.text) > 60 * 1024
  )
    return { code: "invalid", message: "nonempty text up to 61440 bytes required" };
  if (openDialog || asks.some((q) => q.blocking))
    return { code: "refused", message: "answer the dialog first", data: { reason: "busy" } };
  log({ kind: "remote", action: "input.submit", by: "app", text: args.text });
  if (args.text === "/quit") setTimeout(quit, 1800);
  else submit(args.text, false);
  return { code: "ok" };
}

function act(message) {
  if (!isObject(message) || typeof message.action !== "string")
    return { code: "invalid", message: "not an action" };
  if (typeof message.writtenAt !== "number" || Date.now() - message.writtenAt > 60_000)
    return { code: "expired", message: "written over 60 s ago" };
  if (
    isObject(message.expect) &&
    typeof message.expect.rev === "number" &&
    message.expect.rev !== rev &&
    message.action !== "input.submit"
  )
    return { code: "stale", message: "the state changed" };
  const args = isObject(message.args) ? message.args : {};
  switch (message.action) {
    case "prompt.respond":
      return respondPrompt(args);
    case "ask.answer":
      return answerAsk(args);
    case "ask.dismiss": {
      const question = asks.find((q) => q.id === args.id);
      if (!question) return { code: "stale", message: "that question is closed" };
      closeAsk(question, "app", null);
      return { code: "ok" };
    }
    case "input.submit":
      return submitInput(args);
    case "command.run":
      return runCommand(args);
    default:
      return forgeAct(message.action, args);
  }
}

function writeResult(nonce, res) {
  const body = {
    v: 1,
    nonce,
    ok: res.code === "ok",
    code: res.code,
    message: res.message ?? null,
    data: res.data ?? null,
    at: Date.now(),
  };
  const file = path.join(resultsDir, `${nonce}.json`);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function pollControl() {
  let text;
  try {
    text = fs.readFileSync(controlFile, "utf8");
    fs.unlinkSync(controlFile);
  } catch {
    return;
  }
  let ops;
  try {
    ops = JSON.parse(text);
  } catch {
    log({ kind: "remote", op: "control-unreadable" });
    return;
  }
  for (const op of Array.isArray(ops) ? ops : [ops]) {
    if (op.op === "prompt") openPromptDialog(op);
    else if (op.op === "ask") addAsk(op);
    else if (op.op === "desktop-first")
      desktopFirst = op.count === "always" ? Number.POSITIVE_INFINITY : Number(op.count ?? 1);
    else if (op.op === "desktop-answer" && openDialog)
      closePromptDialog("desktop", desktopValue(openDialog));
    else if (op.op === "clear") {
      openDialog = null;
      asks = [];
      settleWaiting();
    }
  }
}

function drain() {
  pollControl();
  let names;
  try {
    names = fs.readdirSync(inboxDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const file = path.join(inboxDir, name);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
      fs.unlinkSync(file);
    } catch {
      continue;
    }
    let message = null;
    try {
      message = JSON.parse(text);
    } catch {}
    const nonce =
      isObject(message) && typeof message.nonce === "string" ? message.nonce : name.slice(0, -5);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(nonce)) continue;
    let res = results.get(nonce);
    if (!res) {
      res =
        isObject(message) && message.v === 1
          ? act(message)
          : { code: "invalid", message: "not a v1 action" };
      results.set(nonce, res);
    }
    writeResult(nonce, res);
  }
  try {
    for (const name of fs.readdirSync(resultsDir)) {
      const file = path.join(resultsDir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > 600_000) fs.rmSync(file, { force: true });
    }
  } catch {}
}

process.on("exit", () => {
  try {
    fs.rmSync(remoteRoot, { recursive: true, force: true });
  } catch {}
});
function setState(next, wait = null) {
  state = next;
  stateSince = Date.now();
  waitingFor = wait;
  writeRecord();
  render();
}

function quit() {
  if (messages > 0) {
    const ended = {
      v: 1,
      host: os.hostname(),
      pid: process.pid,
      sessionId,
      sessionFile,
      cwd: process.cwd(),
      name: null,
      firstPrompt,
      messages,
      model: modelInfo,
      lastRun,
      lastText,
      startedAt,
      endedAt: Date.now(),
      endReason: "quit",
    };
    fs.writeFileSync(path.join(procs, "ended", `${sessionId}.json`), `${JSON.stringify(ended)}\n`);
  }
  try {
    fs.unlinkSync(liveFile);
  } catch {}
  log({ kind: "quit" });
  process.stdout.write("\x1b[?2004l");
  process.exit(0);
}

let replyTimer;
function submit(text, pasted) {
  log({ kind: "submit", text, pasted });
  if (text === "/quit") return quit();
  if (text === "/work") return setState("working");
  if (text === "/wait") return openPromptDialog({});
  if (!text.trim()) return;
  if (!firstPrompt) firstPrompt = text.split("\n")[0];
  append({
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  });
  messages++;
  setState("working");
  clearTimeout(replyTimer);
  replyTimer = setTimeout(() => {
    const reply = `echo: ${text.slice(0, 20)}`;
    append({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: reply }],
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });
    messages++;
    lastText = reply;
    lastRun = {
      startedAt: Date.now() - 200,
      endedAt: Date.now(),
      outcome: "completed",
      error: null,
    };
    setState("idle");
  }, 200);
}

process.on("SIGUSR1", () => {
  if (openDialog) closePromptDialog("desktop", null, true);
  else setState("idle");
});
process.on("SIGUSR2", () => openPromptDialog({}));

// pi-tui draws its prompt editor between two rules of "─" (the host service reads this layout from
// capture-pane to find drafts); the fake draws the same frame around its current input line.
let draftLine = "";
let drawn = false;
function render() {
  if (!drawn) return;
  const cols = Math.max(20, (process.stdout.columns || 80) - 1);
  const rule = "─".repeat(cols);
  const dialogTitle = openDialog?.title ?? asks[0]?.items[0]?.question ?? WAIT_TITLE;
  const body = state === "waiting" ? `[dialog] ${dialogTitle}` : draftLine.replace(/\n/g, "\r\n");
  const editor = state === "waiting" ? body : `${rule}\r\n${body}\r\n${rule}`;
  process.stdout.write(
    `\x1b[H\x1b[2Jfake pi ${sessionId}\r\n\r\n${editor}\r\n  fake · ${state}\r\n`,
  );
}

// Like pi-tui: redraw at the new width when the pty is resized (SIGWINCH), so a rule drawn at an
// older, wider size is never left for tmux to reflow onto a second line.
process.stdout.on("resize", render);

const delay = Number(process.env.FAKE_PI_DELAY_MS ?? 300);
setTimeout(() => {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?2004h");
  drawn = true;
  render();
  if (REMOTE) {
    fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
    // forge's owner.json: a real forge in the same agent dir prunes a folder without one (or
    // with a dead owner) once it is a minute old.
    const owner = path.join(remoteRoot, "owner.json");
    fs.writeFileSync(
      `${owner}.tmp`,
      `${JSON.stringify({ pid: process.pid, procStart, bootId, host: os.hostname(), startedAt: Date.now() })}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(`${owner}.tmp`, owner);
    remoteReady = true;
    setInterval(drain, 150).unref();
  }
  writeRecord();
  log({
    kind: "start",
    argv,
    cwd: process.cwd(),
    sessionId,
    sessionFile,
    tmux: process.env.TMUX ?? null,
    pane: tmuxPane,
    agentEnv: process.env.PI_CODING_AGENT_DIR ?? null,
  });
  if (prompt !== undefined && prompt.trim()) submit(prompt, false);

  const decoder = new StringDecoder("utf8");
  let buf = "";
  let line = "";
  let paste = null;
  let pasted = false;
  let escTimer;
  let escFlush = false;
  process.stdin.on("data", (chunk) => {
    if (chunk.length > 0) {
      log({ kind: "input", hex: chunk.toString("hex") });
      escFlush = false;
    }
    buf += decoder.write(chunk);
    for (;;) {
      draftLine = paste !== null ? line + paste : line;
      render();
      if (paste !== null) {
        const end = buf.indexOf("\x1b[201~");
        if (end < 0) {
          paste += buf;
          buf = "";
          return;
        }
        line += paste + buf.slice(0, end);
        buf = buf.slice(end + 6);
        paste = null;
        pasted = true;
        continue;
      }
      if (!buf) return;
      if (buf.startsWith("\x1b[200~")) {
        paste = "";
        buf = buf.slice(6);
        continue;
      }
      if (buf.startsWith("\x1b")) {
        if (buf.length < 6 && "\x1b[200~".startsWith(buf) && !escFlush) {
          // Maybe the start of a paste: wait briefly, then read it as a lone Escape (as TUIs do).
          clearTimeout(escTimer);
          escTimer = setTimeout(() => {
            escFlush = true;
            process.stdin.emit("data", Buffer.alloc(0));
          }, 50);
          return;
        }
        escFlush = false;
        clearTimeout(escTimer);
        buf = buf.slice(1);
        log({ kind: "escape", state });
        if (state === "working") {
          clearTimeout(replyTimer);
          lastRun = {
            startedAt: stateSince,
            endedAt: Date.now(),
            outcome: "interrupted",
            error: null,
          };
          setState("idle");
        }
        continue;
      }
      const ch = buf[0];
      buf = buf.slice(1);
      if (ch === "\r" || ch === "\n") {
        const text = line;
        const wasPasted = pasted;
        line = "";
        pasted = false;
        submit(text, wasPasted);
      } else if (ch === "\x03") {
        quit();
      } else if (ch === "\x15") {
        line = "";
        pasted = false;
      } else line += ch;
    }
  });
}, delay);

process.on("SIGTERM", () => process.exit(143));
process.on("SIGHUP", () => process.exit(129));
