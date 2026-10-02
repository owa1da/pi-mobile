// forge's sessions registry → the phone dashboard. A faithful port of forge's rules
// (~/.pi/forge/extensions/_lib/sessions-page/{record.ts,store.ts,liveness.ts}): parsing, liveness,
// one row per sessionId, dead live records shown as closed "gone" rows, ended rows from ended/
// within completedHours (24 h) and keepEnded (50), removal markers, sections and order.
// Pure: the host side only lists files (commands.listingScript); this never writes the registry.

import type { SessionModel, SessionRow, SessionSection, SessionsSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Text (record.ts)
// ---------------------------------------------------------------------------

// Built with the RegExp constructor so the sources hold no literal control characters.
const ESC = "\\u001b";
const BEL = "\\u0007";
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;:<=>?]*[ -/]*[@-~]`, "g");
const ANSI_STRING = new RegExp(`${ESC}[\\]_PX^][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, "g");
const ANSI_OTHER = new RegExp(`${ESC}[()*+#%]?.`, "g");
const C0 = "\\u0000-\\u001f";
const C1 = "\\u007f-\\u009f";
const CONTROL = new RegExp(`[${C0}${C1}]`, "g");

export function cleanLine(text: unknown, max = Number.POSITIVE_INFINITY): string {
  if (text === undefined || text === null) return "";
  const flat = String(text)
    .replace(ANSI_CSI, "")
    .replace(ANSI_STRING, "")
    .replace(ANSI_OTHER, "")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cutChars(flat, max);
}

export function cutChars(text: string, max: number): string {
  if (!Number.isFinite(max)) return text;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= 1) return max <= 0 ? "" : "…";
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

export function firstLine(text: unknown, max = Number.POSITIVE_INFINITY): string {
  if (text === undefined || text === null) return "";
  for (const line of String(text).split(/\r?\n/)) {
    const clean = cleanLine(line, max);
    if (clean) return clean;
  }
  return "";
}

export function unmarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(#{1,6}\s+|>\s+|[-*+]\s+)/, ""))
    .join("\n")
    .replace(/(^|[\s([{"'])(\*\*|__)(?=\S)(.+?)(?<=\S)\2(?=$|\s|[)\]}.,;:!?"']+(?:\s|$))/gm, "$1$3")
    .replace(/(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, "$2");
}

export const LIMITS = {
  name: 80,
  firstPrompt: 200,
  waitingTitle: 120,
  activity: 120,
  error: 160,
  lastText: 200,
  question: 200,
} as const;

/** forge's title(): name, else the first prompt's first line without markdown, else "new session". */
export function sessionTitle(record: { name: string | null; firstPrompt: string | null }): string {
  return (
    cleanLine(record.name, LIMITS.name) ||
    firstLine(unmarkdown(record.firstPrompt ?? ""), LIMITS.firstPrompt) ||
    "new session"
  );
}

// ---------------------------------------------------------------------------
// Records (record.ts parse*)
// ---------------------------------------------------------------------------

export type LiveState = "idle" | "working" | "waiting";
export type EndReason = "quit" | "new" | "resume" | "fork" | "gone";

export interface LastRun {
  startedAt?: number;
  endedAt?: number;
  outcome: "completed" | "interrupted" | "error";
  error: string | null;
}

export interface WakeInfo {
  due: number;
  since: number;
  missed: boolean;
  reason: string | null;
  why?: "due" | "unsent";
}

export interface LiveRecord {
  v: number;
  pid: number;
  procStart: string;
  bootId: string;
  host: string;
  startedAt: number;
  updatedAt: number;
  cwd: string;
  tmux: { socket: string; pane: string } | null;
  sessionId: string;
  sessionFile: string | null;
  name: string | null;
  firstPrompt: string | null;
  messages: number;
  model: SessionModel | null;
  state: LiveState;
  stateSince: number;
  waitingFor: { kind: string; title: string } | null;
  activity: string | null;
  agents: { running: number; workflows: number; workflowName: string | null };
  lastRun: LastRun | null;
  lastText: string | null;
  question: string | null;
  pendingQuestions?: number;
  pendingTitle?: string | null;
  pendingSince?: number | null;
  wake?: WakeInfo | null;
  /** Remote channel protocol version (forge's additive `"remote": 1`). */
  remote?: number;
}

export interface EndedRecord {
  v: number;
  host: string;
  pid: number;
  sessionId: string;
  sessionFile: string | null;
  cwd: string;
  name: string | null;
  firstPrompt: string | null;
  messages: number;
  model: SessionModel | null;
  lastRun: LastRun | null;
  lastText: string | null;
  startedAt: number;
  endedAt: number;
  endReason: EndReason;
}

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const strOr = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;
function lineOrNull(text: unknown, max: number): string | null {
  const clean = cleanLine(text, max);
  return clean ? clean : null;
}
const strOrNull = (value: unknown, max: number): string | null =>
  typeof value === "string" ? lineOrNull(value, max) : null;

function parseModel(value: unknown): SessionModel | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (typeof m.provider !== "string" || typeof m.id !== "string") return null;
  const out: SessionModel = { provider: cleanLine(m.provider, 80), id: cleanLine(m.id, 120) };
  if (typeof m.name === "string") out.name = cleanLine(m.name, 120);
  if (typeof m.thinking === "string") out.thinking = cleanLine(m.thinking, 20);
  return out;
}

function parseLastRun(value: unknown): LastRun | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const outcome = r.outcome === "interrupted" || r.outcome === "error" ? r.outcome : "completed";
  const out: LastRun = { outcome, error: strOrNull(r.error, LIMITS.error) };
  if (typeof r.startedAt === "number") out.startedAt = r.startedAt;
  if (typeof r.endedAt === "number") out.endedAt = r.endedAt;
  return out;
}

function parseTmux(value: unknown): { socket: string; pane: string } | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (typeof t.socket !== "string" || typeof t.pane !== "string" || !t.socket || !t.pane)
    return null;
  return { socket: t.socket, pane: t.pane };
}

function parseWake(value: unknown): WakeInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const wake = value as Record<string, unknown>;
  if (typeof wake.due !== "number" || !Number.isFinite(wake.due)) return null;
  return {
    due: wake.due,
    since: typeof wake.since === "number" && Number.isFinite(wake.since) ? wake.since : wake.due,
    missed: wake.missed === true,
    reason: strOrNull(wake.reason, LIMITS.question),
    ...(wake.why === "due" || wake.why === "unsent" ? { why: wake.why } : {}),
  };
}

function parseJson(input: unknown): Record<string, unknown> | undefined {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.v !== "number" || !(obj.v >= 1)) return undefined;
  return obj;
}

const wholeCount = (value: unknown): number => Math.max(0, Math.floor(num(value)));
const fileOrNull = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

function parseWaitingFor(state: LiveState, value: unknown): LiveRecord["waitingFor"] {
  if (state !== "waiting") return null;
  const waiting =
    value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  return {
    kind: strOr(waiting?.kind, "custom"),
    title: cleanLine(waiting?.title, LIMITS.waitingTitle) || "a question",
  };
}

function parseAgents(value: unknown): LiveRecord["agents"] {
  const agents = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    running: wholeCount(agents.running),
    workflows: wholeCount(agents.workflows),
    workflowName: strOrNull(agents.workflowName, 60),
  };
}

/** The optional fields, present only when the record has them. */
function parseOptionalLive(
  obj: Record<string, unknown>,
): Pick<LiveRecord, "pendingQuestions" | "pendingTitle" | "pendingSince" | "wake" | "remote"> {
  const out: Pick<
    LiveRecord,
    "pendingQuestions" | "pendingTitle" | "pendingSince" | "wake" | "remote"
  > = {};
  if (typeof obj.remote === "number" && Number.isInteger(obj.remote) && obj.remote > 0)
    out.remote = obj.remote;
  if ("pendingQuestions" in obj) out.pendingQuestions = wholeCount(obj.pendingQuestions);
  if ("pendingTitle" in obj) out.pendingTitle = strOrNull(obj.pendingTitle, LIMITS.question);
  if ("pendingSince" in obj)
    out.pendingSince =
      typeof obj.pendingSince === "number" && Number.isFinite(obj.pendingSince)
        ? obj.pendingSince
        : null;
  if ("wake" in obj) out.wake = parseWake(obj.wake);
  return out;
}

export function parseLiveRecord(input: unknown): LiveRecord | undefined {
  const obj = parseJson(input);
  if (!obj) return undefined;
  if (typeof obj.pid !== "number" || !Number.isInteger(obj.pid) || obj.pid <= 0) return undefined;
  if (typeof obj.sessionId !== "string" || !obj.sessionId) return undefined;
  const state: LiveState = obj.state === "working" || obj.state === "waiting" ? obj.state : "idle";
  return {
    v: obj.v as number,
    pid: obj.pid,
    procStart: strOr(obj.procStart, ""),
    bootId: strOr(obj.bootId, ""),
    host: strOr(obj.host, ""),
    startedAt: num(obj.startedAt),
    updatedAt: num(obj.updatedAt),
    cwd: strOr(obj.cwd, ""),
    tmux: parseTmux(obj.tmux),
    sessionId: obj.sessionId,
    sessionFile: fileOrNull(obj.sessionFile),
    name: strOrNull(obj.name, LIMITS.name),
    firstPrompt: strOrNull(obj.firstPrompt, LIMITS.firstPrompt),
    messages: wholeCount(obj.messages),
    model: parseModel(obj.model),
    state,
    stateSince: num(obj.stateSince, num(obj.updatedAt)),
    waitingFor: parseWaitingFor(state, obj.waitingFor),
    activity: strOrNull(obj.activity, LIMITS.activity),
    agents: parseAgents(obj.agents),
    lastRun: parseLastRun(obj.lastRun),
    lastText: strOrNull(obj.lastText, LIMITS.lastText),
    question: strOrNull(obj.question, LIMITS.question),
    ...parseOptionalLive(obj),
  };
}

const END_REASONS: ReadonlySet<string> = new Set<EndReason>([
  "quit",
  "new",
  "resume",
  "fork",
  "gone",
]);

export function parseEndedRecord(input: unknown): EndedRecord | undefined {
  const obj = parseJson(input);
  if (!obj) return undefined;
  if (typeof obj.sessionId !== "string" || !obj.sessionId) return undefined;
  const reason =
    typeof obj.endReason === "string" && END_REASONS.has(obj.endReason)
      ? (obj.endReason as EndReason)
      : "quit";
  return {
    v: obj.v as number,
    host: strOr(obj.host, ""),
    pid: wholeCount(obj.pid),
    sessionId: obj.sessionId,
    sessionFile: fileOrNull(obj.sessionFile),
    cwd: strOr(obj.cwd, ""),
    name: strOrNull(obj.name, LIMITS.name),
    firstPrompt: strOrNull(obj.firstPrompt, LIMITS.firstPrompt),
    messages: wholeCount(obj.messages),
    model: parseModel(obj.model),
    lastRun: parseLastRun(obj.lastRun),
    lastText: strOrNull(obj.lastText, LIMITS.lastText),
    startedAt: num(obj.startedAt),
    endedAt: num(obj.endedAt),
    endReason: reason,
  };
}

function endedFromLive(record: LiveRecord, endedAt: number, endReason: EndReason): EndedRecord {
  return {
    v: 1,
    host: record.host,
    pid: record.pid,
    sessionId: record.sessionId,
    sessionFile: record.sessionFile,
    cwd: record.cwd,
    name: record.name,
    firstPrompt: record.firstPrompt,
    messages: record.messages,
    model: record.model,
    lastRun: record.lastRun,
    lastText: record.lastText,
    startedAt: record.startedAt,
    endedAt,
    endReason,
  };
}

// ---------------------------------------------------------------------------
// Listing output (commands.listingScript)
// ---------------------------------------------------------------------------

export interface RawLive {
  /** pid from the file name. */
  filePid: number;
  /** "X" no process, "K" alive (no /proc), "-" unreadable, else /proc start time. */
  procStart: string;
  mtimeSec: number;
  /** Does the record's sessionFile exist: true/false, undefined unknown. */
  sessionFileExists?: boolean;
  text: string;
}

export interface RawListing {
  host: string;
  nowSec: number;
  bootId: string;
  hasProc: boolean;
  live: RawLive[];
  ended: string[];
  removed: string[];
  config?: string;
  complete: boolean;
}

/** "1" → true, "0" → false, anything else unknown. */
function flag(text: string | undefined): boolean | undefined {
  if (text === "1") return true;
  if (text === "0") return false;
  return undefined;
}

export function parseListing(stdout: string, nonce: string): RawListing {
  const out: RawListing = {
    host: "",
    nowSec: 0,
    bootId: "",
    hasProc: true,
    live: [],
    ended: [],
    removed: [],
    complete: false,
  };
  let current: { kind: "L"; raw: RawLive } | { kind: "E" | "R" | "C"; lines: string[] } | undefined;
  const body: string[] = [];
  const close = () => {
    if (!current) return;
    const text = body.join("\n").trim();
    body.length = 0;
    if (current.kind === "L") {
      current.raw.text = text;
      out.live.push(current.raw);
    } else if (current.kind === "E") out.ended.push(text);
    else if (current.kind === "R") out.removed.push(text);
    else out.config = text;
    current = undefined;
  };
  const prefix = `${nonce} `;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(prefix)) {
      if (current) body.push(line);
      continue;
    }
    close();
    const parts = line.slice(prefix.length).split(" ");
    const tag = parts[0];
    if (tag === "H") {
      out.host = parts.slice(1, -1).join(" ");
      out.nowSec = Number(parts[parts.length - 1]) || 0;
    } else if (tag === "B") out.bootId = (parts[1] ?? "").trim();
    else if (tag === "P") out.hasProc = parts[1] === "1";
    else if (tag === "L") {
      current = {
        kind: "L",
        raw: {
          filePid: Number(parts[1]),
          procStart: parts[2] ?? "-",
          mtimeSec: Number(parts[3]) || 0,
          sessionFileExists: flag(parts[4]),
          text: "",
        },
      };
    } else if (tag === "E" || tag === "R" || tag === "C") current = { kind: tag, lines: [] };
    else if (tag === "Z") out.complete = true;
  }
  close();
  return out;
}

// ---------------------------------------------------------------------------
// Liveness (liveness.ts), registry poll (store.ts pollRegistry + moveDeadToEnded + pruneEnded)
// ---------------------------------------------------------------------------

export type Liveness = "alive" | "dead" | "elsewhere";

export function livenessOf(record: LiveRecord, raw: RawLive, listing: RawListing): Liveness {
  if (record.host && listing.host && record.host !== listing.host) return "elsewhere";
  if (record.bootId && listing.bootId && record.bootId !== listing.bootId) return "dead";
  if (raw.procStart === "X") return "dead";
  if (raw.procStart === "K" || raw.procStart === "-") return "alive";
  if (record.procStart && raw.procStart && raw.procStart !== record.procStart) return "dead";
  return "alive";
}

export interface SessionsSettings {
  completedHours: number;
  keepEnded: number;
}

export const DEFAULT_SETTINGS: SessionsSettings = { completedHours: 24, keepEnded: 50 };

/** forge.json `forge.sessions` (completedHours ≥ 1, keepEnded ≥ 0). */
export function parseSettings(text: string | undefined): SessionsSettings {
  if (!text) return DEFAULT_SETTINGS;
  let raw: Record<string, unknown> = {};
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const forge = json?.forge as Record<string, unknown> | undefined;
    const sessions = (forge?.sessions ?? json?.sessions) as Record<string, unknown> | undefined;
    if (sessions && typeof sessions === "object") raw = sessions;
  } catch {
    return DEFAULT_SETTINGS;
  }
  const count = (value: unknown, fallback: number, min: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.floor(value))
      : fallback;
  return {
    completedHours: count(raw.completedHours, DEFAULT_SETTINGS.completedHours, 1),
    keepEnded: count(raw.keepEnded, DEFAULT_SETTINGS.keepEnded, 0),
  };
}

const HOUR_MS = 3_600_000;

export interface Registry {
  live: LiveRecord[];
  ended: EndedRecord[];
}

/** One record per sessionId: the newest update wins, then the newest start, then the higher pid. */
function supersedes(record: LiveRecord, previous: LiveRecord | undefined): boolean {
  if (!previous) return true;
  if (record.updatedAt !== previous.updatedAt) return record.updatedAt > previous.updatedAt;
  if (record.startedAt !== previous.startedAt) return record.startedAt > previous.startedAt;
  return record.pid > previous.pid;
}

/** Live records (one per sessionId) and dead processes as `gone` ended records. */
function scanLive(listing: RawListing): {
  bySession: Map<string, LiveRecord>;
  gone: EndedRecord[];
} {
  const bySession = new Map<string, LiveRecord>();
  const gone: EndedRecord[] = [];
  for (const raw of listing.live) {
    const record = parseLiveRecord(raw.text);
    if (!record || record.pid !== raw.filePid) continue;
    const state = livenessOf(record, raw, listing);
    if (state === "elsewhere") continue;
    if (state === "dead") {
      // moveDeadToEnded: a conversation on disk becomes a `gone` ended record dated by the file's mtime.
      if (record.messages > 0 && record.sessionFile && raw.sessionFileExists !== false)
        gone.push(endedFromLive(record, raw.mtimeSec * 1000, "gone"));
      continue;
    }
    if (supersedes(record, bySession.get(record.sessionId)))
      bySession.set(record.sessionId, record);
  }
  return { bySession, gone };
}

/** What forge's page would hold after one poll: live (one per sessionId) and the ended rows it shows. */
export function pollListing(
  listing: RawListing,
  settings: SessionsSettings = DEFAULT_SETTINGS,
): Registry {
  const nowMs = listing.nowSec * 1000;
  const host = listing.host;
  const { bySession, gone } = scanLive(listing);
  const removed = new Set<string>();
  for (const text of listing.removed) {
    try {
      const marker = JSON.parse(text) as Record<string, unknown>;
      if (typeof marker.sessionId === "string" && typeof marker.host === "string")
        removed.add(`${marker.host}\n${marker.sessionId}`);
    } catch {
      // unreadable marker: ignored, as forge's dismissed() does
    }
  }
  const endedById = new Map<string, EndedRecord>();
  for (const text of listing.ended) {
    const record = parseEndedRecord(text);
    if (record) endedById.set(record.sessionId, record);
  }
  // ended/<sessionId>.json is one file per session: a dead process's record replaces it.
  for (const record of gone) endedById.set(record.sessionId, record);
  const otherHost = (recordHost: string) => Boolean(recordHost && host && recordHost !== host);
  // pruneEnded: this host's newest keepEnded within completedHours.
  const mine = [...endedById.values()]
    .filter((record) => !otherHost(record.host))
    .sort((a, b) => b.endedAt - a.endedAt)
    .filter(
      (record, index) =>
        index < settings.keepEnded && nowMs - record.endedAt <= settings.completedHours * HOUR_MS,
    );
  const ended = mine.filter(
    (record) =>
      !bySession.has(record.sessionId) && !removed.has(`${record.host}\n${record.sessionId}`),
  );
  return { live: [...bySession.values()], ended };
}

// ---------------------------------------------------------------------------
// Rows (record.ts sectionOf / rowFromLive / rowFromEnded / sortRows / statusParts)
// ---------------------------------------------------------------------------

const questionsWait = (pending: number) => Number.isFinite(pending) && pending > 0;
const neverPrompted = (record: LiveRecord) => record.messages === 0 && !record.lastRun;

export function sectionOf(record: LiveRecord): SessionSection {
  if (record.state === "waiting" || questionsWait(record.pendingQuestions ?? 0)) return "needs";
  if (record.state === "working") return "working";
  if (record.wake) return record.wake.missed ? "needs" : "working";
  return record.question !== null || neverPrompted(record) ? "needs" : "completed";
}

function asks(record: LiveRecord): boolean {
  return (
    record.state === "waiting" ||
    questionsWait(record.pendingQuestions ?? 0) ||
    (record.state === "idle" && record.question !== null)
  );
}

function liveSince(record: LiveRecord): number {
  if (
    record.state !== "waiting" &&
    questionsWait(record.pendingQuestions ?? 0) &&
    typeof record.pendingSince === "number"
  )
    return record.pendingSince;
  if (record.state === "idle" && record.wake) return record.wake.since;
  return record.stateSince;
}

function askingText(record: LiveRecord): string | undefined {
  const pending = record.pendingQuestions ?? 0;
  if (record.state === "waiting") return record.waitingFor?.title || "a question";
  if (questionsWait(pending))
    return record.pendingTitle || (pending === 1 ? "a question" : `${pending} questions`);
  if (record.state === "idle" && record.question) return record.question;
  return undefined;
}

function agentsText(agents: LiveRecord["agents"], activity: string | null): string {
  const count = `${agents.running} ${agents.running === 1 ? "agent" : "agents"}`;
  if (agents.workflows > 0)
    return (
      `workflow ${agents.workflowName ?? ""}`.trimEnd() + (agents.running > 0 ? ` · ${count}` : "")
    );
  return activity ? `${count} · ${activity}` : count;
}

function wakeText(wake: WakeInfo): string {
  if (wake.why === "unsent") return "wake-up not sent";
  if (wake.missed) return wake.why === "due" ? "wake-up due" : "wake-up missed";
  return wake.reason ? `waiting for a wake-up · ${wake.reason}` : "waiting for a wake-up";
}

function runText(run: LastRun | null, lastText: string | null): string | undefined {
  if (run?.outcome === "error") return `error: ${run.error || "the run failed"}`;
  if (run?.outcome === "interrupted") return "interrupted";
  return lastText ?? undefined;
}

function liveDetail(record: LiveRecord): string | undefined {
  if (record.state === "working" && (record.agents.running > 0 || record.agents.workflows > 0))
    return agentsText(record.agents, record.activity);
  if (record.state === "working") return record.activity || "working…";
  if (record.state === "waiting" || questionsWait(record.pendingQuestions ?? 0))
    return record.activity ?? undefined;
  if (record.wake) return wakeText(record.wake);
  if (neverPrompted(record)) return "send a prompt to start";
  return runText(record.lastRun, record.lastText);
}

export function rowFromLive(record: LiveRecord): SessionRow & { asks: boolean } {
  const row: SessionRow & { asks: boolean } = {
    key: record.sessionId,
    sessionId: record.sessionId,
    section: sectionOf(record),
    live: true,
    title: sessionTitle(record),
    cwd: record.cwd,
    state: record.state,
    since: liveSince(record),
    messages: record.messages,
    pid: record.pid,
    asks: asks(record),
  };
  if (record.model) row.model = record.model;
  const asking = askingText(record);
  if (asking) row.asking = asking;
  const detail = liveDetail(record);
  if (detail) row.detail = detail;
  if (record.sessionFile) row.sessionFile = record.sessionFile;
  if (record.tmux) row.tmux = { socket: record.tmux.socket, pane: record.tmux.pane };
  if (record.wake) {
    row.wake = { due: record.wake.due, missed: record.wake.missed };
    if (record.wake.reason) row.wake.reason = record.wake.reason;
  }
  if (record.remote !== undefined) row.remote = record.remote;
  return row;
}

export function rowFromEnded(record: EndedRecord): SessionRow & { asks: boolean } {
  const row: SessionRow & { asks: boolean } = {
    key: record.sessionId,
    sessionId: record.sessionId,
    section: "completed",
    live: false,
    endReason: record.endReason,
    title: sessionTitle(record),
    cwd: record.cwd,
    state: "closed",
    since: record.endedAt,
    messages: record.messages,
    asks: false,
  };
  if (record.model) row.model = record.model;
  const detail = runText(record.lastRun, record.lastText);
  if (detail) row.detail = detail;
  if (record.sessionFile) row.sessionFile = record.sessionFile;
  return row;
}

/** Needs: asking first, then newest; Working: newest; Completed: live before closed, newest. */
export function sortRows<T extends SessionRow & { asks: boolean }>(rows: readonly T[]): T[] {
  const newest = (a: T, b: T) => b.since - a.since || a.key.localeCompare(b.key);
  const needs = rows
    .filter((row) => row.section === "needs")
    .sort((a, b) => Number(b.asks) - Number(a.asks) || newest(a, b));
  const working = rows.filter((row) => row.section === "working").sort(newest);
  const completed = rows
    .filter((row) => row.section === "completed")
    .sort((a, b) => Number(!a.live) - Number(!b.live) || newest(a, b));
  return [...needs, ...working, ...completed];
}

export function buildSnapshot(listing: RawListing, settings?: SessionsSettings): SessionsSnapshot {
  const registry = pollListing(listing, settings ?? parseSettings(listing.config));
  const rows = sortRows([
    ...registry.live.map(rowFromLive),
    ...registry.ended.map(rowFromEnded),
  ]).map(({ asks: _asks, ...row }) => row as SessionRow);
  const counts: Record<SessionSection, number> = { needs: 0, working: 0, completed: 0 };
  for (const row of rows) counts[row.section]++;
  return { hostName: listing.host, hostNow: listing.nowSec, rows, counts };
}
