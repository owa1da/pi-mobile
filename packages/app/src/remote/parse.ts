// Defensive parsing of forge's state.json and result files. Unknown fields are ignored, an absent
// area stays undefined (the app hides its screen), and a malformed area is dropped on its own so
// one bad field never hides the rest. Text is capped at the contract's limits.

import { cleanLine } from "@/host/procs";
import {
  REMOTE_PROTOCOL,
  type AskItem,
  type AskOption,
  type AskQuestion,
  type PromptKind,
  type RemoteBtw,
  type RemoteCheckpoint,
  type RemoteCommand,
  type RemoteFooter,
  type RemoteFooterModel,
  type RemotePins,
  type RemotePrompt,
  type RemoteResult,
  type RemoteSide,
  type RemoteState,
  type RemoteTask,
  type RemoteWake,
  type ResultCode,
  type TaskKind,
} from "./types";

/** Contract caps. */
export const CAPS = {
  text: 500,
  options: 50,
  option: 200,
  tasks: 100,
  checkpoints: 200,
  commands: 200,
  questions: 50,
  items: 20,
  pins: 100,
} as const;

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

// C0 controls except \t and \n, DEL and C1 (ANSI never reaches a native Text).
// eslint-disable-next-line no-control-regex
const CONTROL_ML = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** One line of text (titles, labels), capped. */
function line(value: unknown, max: number = CAPS.text): string {
  return typeof value === "string" ? cleanLine(value, max) : "";
}

function lineOrNull(value: unknown, max: number = CAPS.text): string | null {
  const text = line(value, max);
  return text ? text : null;
}

/** Multi-line text (a dialog's message, an editor's prefill): newlines kept, controls removed. */
export function multiline(value: unknown, max: number = CAPS.text): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(CONTROL_ML, "");
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

const PROMPT_KINDS: ReadonlySet<string> = new Set<PromptKind>([
  "select",
  "confirm",
  "input",
  "editor",
  "custom",
]);

function stringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (out.length >= maxItems) break;
    const text = line(item, maxChars);
    if (text) out.push(text);
  }
  return out;
}

export function parsePrompt(value: unknown): RemotePrompt | null {
  if (!isObj(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.kind !== "string" || !PROMPT_KINDS.has(value.kind)) return null;
  const kind = value.kind as PromptKind;
  const options = Array.isArray(value.options)
    ? stringList(value.options, CAPS.options, CAPS.option)
    : null;
  // A select with nothing to pick cannot be answered here.
  const choosable = kind !== "select" || (options !== null && options.length > 0);
  return {
    id: value.id,
    kind,
    title: line(value.title) || "",
    message: multiline(value.message),
    options,
    placeholder: lineOrNull(value.placeholder),
    prefill: multiline(value.prefill),
    answerable: value.answerable === true && kind !== "custom" && choosable,
    held: value.held === true,
    since: finite(value.since) ?? 0,
  };
}

function parseAskOption(value: unknown): AskOption | null {
  if (typeof value === "string") {
    const label = line(value, CAPS.option);
    return label ? { label, description: null } : null;
  }
  if (!isObj(value)) return null;
  const label = line(value.label, CAPS.option);
  if (!label) return null;
  return { label, description: lineOrNull(value.description) };
}

function parseAskItem(value: unknown): AskItem | null {
  if (!isObj(value)) return null;
  const question = multiline(value.question)?.trim();
  if (!question) return null;
  const options: AskOption[] = [];
  if (Array.isArray(value.options)) {
    for (const raw of value.options) {
      if (options.length >= CAPS.options) break;
      const option = parseAskOption(raw);
      // Labels are the answer's identity: a duplicate could never be told apart.
      if (option && !options.some((o) => o.label === option.label)) options.push(option);
    }
  }
  return {
    question,
    header: lineOrNull(value.header, 60),
    multiSelect: value.multiSelect === true && options.length > 0,
    options,
  };
}

export function parseQuestion(value: unknown): AskQuestion | null {
  if (!isObj(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (!Array.isArray(value.items)) return null;
  const items: AskItem[] = [];
  for (const raw of value.items) {
    if (items.length >= CAPS.items) break;
    const item = parseAskItem(raw);
    // A dropped item would shift every later answer onto the wrong question: drop the whole set.
    if (!item) return null;
    items.push(item);
  }
  if (items.length === 0) return null;
  return {
    id: value.id,
    blocking: value.blocking === true,
    askedAt: finite(value.askedAt) ?? 0,
    status: value.status === "answered-unsent" ? "answered-unsent" : "open",
    items,
  };
}

function parseFooterModel(value: unknown): RemoteFooterModel | null {
  if (!isObj(value)) return null;
  const id = line(value.id, 120);
  if (!id) return null;
  return {
    provider: line(value.provider, 80),
    id,
    name: line(value.name, 200),
    thinking: lineOrNull(value.thinking, 40),
  };
}

const TONES = new Set(["normal", "warning", "error"]);

function parseFooter(value: unknown): RemoteFooter | null {
  if (!isObj(value)) return null;
  const tone = typeof value.contextTone === "string" ? value.contextTone : "";
  return {
    model: parseFooterModel(value.model),
    contextPercent: finite(value.contextPercent),
    contextTokens: finite(value.contextTokens),
    contextWindow: finite(value.contextWindow),
    cost: finite(value.cost),
    compactAt: finite(value.compactAt),
    compactionPaused: value.compactionPaused === true,
    contextTone: TONES.has(tone) ? (tone as RemoteFooter["contextTone"]) : "normal",
    items: stringList(value.items, 20, 200),
  };
}

function parseBtw(value: unknown): RemoteBtw | null {
  if (!isObj(value)) return null;
  return {
    open: value.open === true,
    pending: value.pending === true,
    question: multiline(value.question)?.trim() || null,
    error: lineOrNull(value.error),
  };
}

function parseWake(value: unknown): RemoteWake | null {
  if (!isObj(value)) return null;
  const due = finite(value.due);
  if (due === null) return null;
  return { due, reason: lineOrNull(value.reason), missed: value.missed === true };
}

function parseSide(value: unknown): RemoteSide | null {
  if (!isObj(value)) return null;
  return {
    open: value.open === true,
    working: value.working === true,
    sessionFile:
      typeof value.sessionFile === "string" && value.sessionFile ? value.sessionFile : null,
  };
}

const TASK_KINDS: ReadonlySet<string> = new Set<TaskKind>([
  "shell",
  "workflow",
  "agent",
  "wake",
  "session",
]);
const pathOrNull = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

function parseTask(value: unknown): RemoteTask | null {
  if (!isObj(value)) return null;
  const owner = line(value.owner, 120);
  const key = line(value.key, 200);
  if (!owner || !key || typeof value.kind !== "string" || !TASK_KINDS.has(value.kind)) return null;
  return {
    owner,
    key,
    kind: value.kind as TaskKind,
    name: line(value.name) || key,
    status: line(value.status, 40),
    detail: lineOrNull(value.detail),
    canStop: value.canStop === true,
    canResume: value.canResume === true,
    sessionFile: pathOrNull(value.sessionFile),
    logPath: pathOrNull(value.logPath),
    runDir: pathOrNull(value.runDir),
  };
}

function parseCheckpoint(value: unknown): RemoteCheckpoint | null {
  if (!isObj(value)) return null;
  const n = finite(value.n);
  if (n === null) return null;
  return {
    n,
    entryId: typeof value.entryId === "string" && value.entryId ? value.entryId : null,
    label: line(value.label),
    at: finite(value.at) ?? 0,
    files: finite(value.files) ?? 0,
    added: finite(value.added) ?? 0,
    removed: finite(value.removed) ?? 0,
  };
}

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;

function parseCommand(value: unknown): RemoteCommand | null {
  if (!isObj(value)) return null;
  // A row may name itself "/x" or "x"; the app keeps the bare name.
  const raw = typeof value.name === "string" ? value.name.trim().replace(/^\//, "") : "";
  if (!COMMAND_NAME.test(raw) || raw.length > 64) return null;
  return { name: raw, description: lineOrNull(value.description, CAPS.option) };
}

function list<T>(value: unknown, max: number, parse: (item: unknown) => T | null): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const raw of value) {
    if (out.length >= max) break;
    const item = parse(raw);
    if (item) out.push(item);
  }
  return out;
}

function parsePins(value: unknown): RemotePins | undefined {
  if (!isObj(value)) return undefined;
  return {
    pinned: stringList(value.pinned, CAPS.pins, 200),
    recent: stringList(value.recent, CAPS.pins, 200),
  };
}

function parseJsonObject(input: unknown): Obj | undefined {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  return isObj(value) ? value : undefined;
}

/** The optional areas: present only when the file has them; a malformed one reads as absent. */
function parseAreas(obj: Obj): Partial<RemoteState> {
  const out: Partial<RemoteState> = {};
  if ("prompt" in obj) out.prompt = obj.prompt === null ? null : parsePrompt(obj.prompt);
  const questions = list(obj.questions, CAPS.questions, parseQuestion);
  if (questions) out.questions = questions;
  if ("footer" in obj) out.footer = obj.footer === null ? null : parseFooter(obj.footer);
  if ("wake" in obj) out.wake = obj.wake === null ? null : parseWake(obj.wake);
  if ("side" in obj) out.side = obj.side === null ? null : parseSide(obj.side);
  const tasks = list(obj.tasks, CAPS.tasks, parseTask);
  if (tasks) out.tasks = tasks;
  const checkpoints = list(obj.checkpoints, CAPS.checkpoints, parseCheckpoint);
  if (checkpoints) out.checkpoints = checkpoints;
  const commands = list(obj.commands, CAPS.commands, parseCommand);
  if (commands) out.commands = commands;
  const pins = parsePins(obj.pins);
  if (pins) out.pins = pins;
  if ("btw" in obj) out.btw = obj.btw === null ? null : parseBtw(obj.btw);
  return out;
}

/**
 * state.json → RemoteState, or undefined when it is not a v1 state of `pid` (unreadable, partial,
 * another protocol version, or a file left by another process).
 */
export function parseRemoteState(input: unknown, pid?: number): RemoteState | undefined {
  const obj = parseJsonObject(input);
  if (!obj) return undefined;
  if (obj.v !== REMOTE_PROTOCOL) return undefined;
  const filePid = finite(obj.pid);
  if (filePid === null || !Number.isInteger(filePid) || filePid <= 0) return undefined;
  if (pid !== undefined && filePid !== pid) return undefined;
  return {
    v: REMOTE_PROTOCOL,
    pid: filePid,
    sessionId: typeof obj.sessionId === "string" ? obj.sessionId : "",
    rev: finite(obj.rev) ?? 0,
    updatedAt: finite(obj.updatedAt) ?? 0,
    view: line(obj.view, 120) || "main",
    draft: obj.draft === true,
    ...parseAreas(obj),
  };
}

const RESULT_CODES: ReadonlySet<string> = new Set<ResultCode>([
  "ok",
  "stale",
  "expired",
  "invalid",
  "refused",
  "unknown-action",
  "error",
]);

/** A result file → RemoteResult, or undefined when it is not one for `nonce`. */
export function parseRemoteResult(input: unknown, nonce?: string): RemoteResult | undefined {
  const obj = parseJsonObject(input);
  if (!obj) return undefined;
  if (typeof obj.nonce !== "string") return undefined;
  if (nonce !== undefined && obj.nonce !== nonce) return undefined;
  // An unknown code is a failure the app cannot name: read it as an error.
  let code: ResultCode =
    typeof obj.code === "string" && RESULT_CODES.has(obj.code) ? (obj.code as ResultCode) : "error";
  const ok = obj.ok === true && code === "ok";
  if (!ok && code === "ok") code = "error";
  return {
    v: finite(obj.v) ?? REMOTE_PROTOCOL,
    nonce: obj.nonce,
    ok,
    code,
    message: lineOrNull(obj.message),
    data: obj.data ?? null,
    at: finite(obj.at) ?? 0,
  };
}

/** The open prompt the app can show, if any. */
export function openPrompt(state: RemoteState | undefined): RemotePrompt | null {
  return state?.prompt ?? null;
}

/** Open ask items, blocking first (then oldest first), as forge's queue would answer them. */
export function openQuestions(state: RemoteState | undefined): AskQuestion[] {
  const open = (state?.questions ?? []).filter((q) => q.status === "open");
  return open
    .map((question, index) => ({ question, index }))
    .sort(
      (a, b) =>
        Number(b.question.blocking) - Number(a.question.blocking) ||
        a.question.askedAt - b.question.askedAt ||
        a.index - b.index,
    )
    .map(({ question }) => question);
}
