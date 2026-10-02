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
  leaf = full.id;
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
  { name: "model", description: "Pick the model and thinking level" },
  { name: "rename", description: "Rename this session" },
  { name: "rewind", description: "Rewind the conversation and code" },
  { name: "side", description: "Open a side conversation" },
  { name: "tasks", description: "Background tasks, agents and workflows" },
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
    name: null,
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
    prompt: openDialog,
    questions: asks,
    footer: {
      model: { provider: modelInfo.provider, id: modelInfo.id, name: "", thinking: thinking ?? "" },
      contextPercent: Math.min(100, messages * 3),
      contextTokens: messages * 6000,
      contextWindow: 200000,
      cost: Math.round(messages * 0.021 * 1000) / 1000,
    },
    commands: COMMANDS,
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
  if (TUI_VIEWS.has(name))
    return { code: "refused", message: `/${name} opens a terminal view: use its action` };
  if (openDialog)
    return { code: "refused", message: "a dialog or a panel has the terminal's input" };
  log({ kind: "remote", action: "command.run", by: "app", line });
  notice(`Ran ${line}`);
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
    message.expect.rev !== rev
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
    case "command.run":
      return runCommand(args);
    default:
      return { code: "unknown-action", message: `${message.action} is not implemented` };
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
