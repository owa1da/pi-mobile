#!/usr/bin/env node
// A stand-in for interactive pi + forge's sessions registry, for host integration tests only.
// It writes <agentDir>/forge/procs/<pid>.json like forge (same key order), a session .jsonl like
// pi, puts the tty in raw mode with bracketed paste on, and logs every input byte to
// <agentDir>/fake-pi/<pid>.log (one JSON event per line). Synthetic: no real session content.
//
// Input: a bracketed paste then CR submits the paste; a typed line then CR submits it; a lone
// ESC aborts (state -> idle). Commands: "/quit" ends (ended record, live file removed),
// "/work" stays working until ESC, "/wait" opens a dialog (state waiting) until SIGUSR1.

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
  };
}
const liveFile = path.join(procs, `${process.pid}.json`);
function writeRecord() {
  const tmp = `${liveFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(record())}\n`, { mode: 0o600 });
  fs.renameSync(tmp, liveFile);
}
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
  if (text === "/wait") return setState("waiting", { kind: "select", title: WAIT_TITLE });
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

process.on("SIGUSR1", () => setState("idle"));
process.on("SIGUSR2", () => setState("waiting", { kind: "select", title: WAIT_TITLE }));

// pi-tui draws its prompt editor between two rules of "─" (the host service reads this layout from
// capture-pane to find drafts); the fake draws the same frame around its current input line.
let draftLine = "";
let drawn = false;
function render() {
  if (!drawn) return;
  const cols = Math.max(20, (process.stdout.columns || 80) - 1);
  const rule = "─".repeat(cols);
  const body = state === "waiting" ? `[dialog] ${WAIT_TITLE}` : draftLine.replace(/\n/g, "\r\n");
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
