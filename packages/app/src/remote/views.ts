// Pure view models for the native forge screens: they read an action's `data` defensively (the
// shapes of contract v1.2, as forge builds them), group rows as forge's TUI does, and word the few
// numbers the CLI shows the way the CLI words them. No React, no I/O.

import { cleanLine } from "@/host/procs";
import { multiline } from "./parse";
import type { ContextTone, RemoteCheckpoint, RemoteFooter, RemoteTask } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 500): string => (typeof v === "string" ? cleanLine(v, max) : "");
const strOrNull = (v: unknown, max = 500): string | null => str(v, max) || null;
/** The CLI's separator between the parts of one line. */
export const SEP = " · ";

// ---------- /rewind ----------

export type RewindMode = "both" | "conversation" | "code";

/** The confirm screen's four choices, in the CLI's order (the last one cancels). */
export const REWIND_CHOICES: readonly (RewindMode | "cancel")[] = [
  "both",
  "conversation",
  "code",
  "cancel",
];

/** `rewind.preview` data (v1.2): the confirm step /rewind shows for one prompt. */
export interface RewindPreview {
  entryId: string;
  quote: string;
  at: number | null;
  /** "code": the panel's heading names the code too; "conversation": only the conversation. */
  heading: "code" | "conversation";
  /** The list row's change words ("3 files changed +17 -4", "No code changes", "! a.txt left alone"). */
  row: string | null;
  code: {
    files: string[];
    added: number;
    removed: number;
    counted: boolean;
    /** "The code will be restored +4 -1 in a.ts and b.ts." */
    sentence: string;
  } | null;
  /** The choices forge offers, in the CLI's order. */
  modes: RewindMode[];
  warnings: string[];
}

const MODES: readonly RewindMode[] = ["both", "conversation", "code"];

/** Without a modes list: every choice when forge counted code, else the conversation alone. */
function defaultModes(hasCode: boolean): RewindMode[] {
  return hasCode ? [...MODES] : ["conversation"];
}

export function parseRewindPreview(data: unknown): RewindPreview | null {
  if (!isObj(data) || typeof data.entryId !== "string" || !data.entryId) return null;
  const code = isObj(data.code)
    ? {
        files: Array.isArray(data.code.files)
          ? data.code.files.map((f) => str(f, 200)).filter(Boolean)
          : [],
        added: num(data.code.added) ?? 0,
        removed: num(data.code.removed) ?? 0,
        counted: data.code.counted === true,
        sentence: str(data.code.sentence),
      }
    : null;
  const listed = Array.isArray(data.modes)
    ? MODES.filter((m) => (data.modes as unknown[]).includes(m))
    : [];
  return {
    entryId: data.entryId,
    quote: multiline(data.quote) ?? "",
    at: num(data.at),
    heading: data.heading === "code" ? "code" : "conversation",
    row: strOrNull(data.row),
    code,
    modes: listed.length > 0 ? listed : defaultModes(code !== null),
    warnings: Array.isArray(data.warnings) ? data.warnings.map((w) => str(w)).filter(Boolean) : [],
  };
}

/** The line under a prompt in the list: forge's own row words; nothing for an untracked prompt. */
export function rewindLine(preview: RewindPreview): string {
  return preview.row ?? "";
}

/** The choices to show for a preview: forge's modes, then cancel. */
export function rewindChoices(preview: RewindPreview | null): (RewindMode | "cancel")[] {
  const modes = preview?.modes ?? ["conversation"];
  return [...REWIND_CHOICES.filter((c) => c !== "cancel" && modes.includes(c)), "cancel"];
}

export interface RewindPrompt {
  entryId: string;
  text: string;
}

/** The prompts on this branch (oldest first), from the chat rows; pending echoes left out. */
export function rewindPrompts(
  rows: readonly { kind: string; key: string; text?: string; pending?: boolean }[],
): RewindPrompt[] {
  const out: RewindPrompt[] = [];
  for (const row of rows) {
    if (row.kind !== "user" || row.pending) continue;
    const text = (row.text ?? "").trim();
    if (text) out.push({ entryId: row.key, text });
  }
  return out;
}

// ---------- /diff, /restore ----------

export type DiffLineKind = "file" | "hunk" | "add" | "del" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Its line number in the patch (0-based): a stable list key. */
  at: number;
}

export interface CheckpointDiff {
  patch: string;
  truncated: boolean;
}

export function parseCheckpointDiff(data: unknown): CheckpointDiff | null {
  if (!isObj(data) || typeof data.patch !== "string") return null;
  return { patch: data.patch, truncated: data.truncated === true };
}

/** Lines over this many are not drawn (a 512 KiB patch would stall the list). */
export const DIFF_MAX_LINES = 4000;

/** A unified patch → lines tagged for their tint. */
export function diffLines(
  patch: string,
  max = DIFF_MAX_LINES,
): { lines: DiffLine[]; cut: boolean } {
  const raw = patch.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const lines: DiffLine[] = [];
  for (const text of raw.slice(0, max)) {
    let kind: DiffLineKind = "context";
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(text))
      kind = "file";
    else if (text.startsWith("@@")) kind = "hunk";
    else if (text.startsWith("+")) kind = "add";
    else if (text.startsWith("-")) kind = "del";
    lines.push({ kind, text, at: lines.length });
  }
  return { lines, cut: raw.length > max };
}

/** Newest first, as the CLI's completion lists them. */
export function checkpointsNewestFirst(list: readonly RemoteCheckpoint[]): RemoteCheckpoint[] {
  return [...list].sort((a, b) => b.n - a.n);
}

/** "2 files changed +21 -2" / "No code changes": a change summary in the CLI's words. */
export function changeText(files: number, added: number, removed: number): string {
  if (files <= 0) return "No code changes";
  const counts = [added ? `+${added}` : "", removed ? `-${removed}` : ""].filter(Boolean).join(" ");
  const what = files === 1 ? "1 file changed" : `${files} files changed`;
  return counts ? `${what} ${counts}` : what;
}

/** A checkpoint row's title: forge's Tab-list row (prompt · change words), else its counts. */
export function checkpointTitle(cp: RemoteCheckpoint, untitled: string): string {
  return `${cp.n}: ${cp.label || `${untitled}${SEP}${changeText(cp.files, cp.added, cp.removed)}`}`;
}

/** "41s ago", "5m ago", "3h ago", "2d ago". */
export function agoText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

// ---------- /tasks ----------

const RUNNING = /^(running|working|waiting|queued|starting)/i;

/** Running first (as forge's panel), then the rest, each in forge's order. */
export function taskRows(tasks: readonly RemoteTask[]): RemoteTask[] {
  const running = (t: RemoteTask) => RUNNING.test(t.status);
  return [...tasks.filter(running), ...tasks.filter((t) => !running(t))];
}

export const taskRunning = (task: RemoteTask): boolean => RUNNING.test(task.status);

/** The task a route names (owner + key). */
export function findTask(
  tasks: readonly RemoteTask[] | undefined,
  owner: string,
  key: string,
): RemoteTask | undefined {
  return tasks?.find((t) => t.owner === owner && t.key === key);
}

/** `task.tail` data → its text. */
export function tailText(data: unknown): string {
  if (!isObj(data) || typeof data.text !== "string") return "";
  return multiline(data.text, 256 * 1024) ?? "";
}

/** What a task's screen shows: a shell's log (task.tail), an agent's transcript, else its detail. */
export function taskView(task: RemoteTask): "tail" | "transcript" | "detail" {
  if (task.kind === "shell") return "tail";
  if (task.kind === "agent" && task.sessionFile) return "transcript";
  return "detail";
}

// ---------- /model ----------

export interface ModelChoice {
  ref: string;
  name: string;
}

export interface ModelGroup {
  key: "pinned" | "recent" | "all";
  models: ModelChoice[];
}

export interface ThinkingInfo {
  level: string;
  levels: string[];
}

export interface ModelList {
  available: ModelChoice[];
  current: string | null;
  /** null: the current model does not think (no levels to pick). */
  thinking: ThinkingInfo | null;
}

/** `thinking.set` data (and `models.list`'s `thinking`) → level and levels. */
export function parseThinking(data: unknown): ThinkingInfo | null {
  if (!isObj(data)) return null;
  const level = str(data.level, 40);
  const levels = Array.isArray(data.levels)
    ? data.levels.map((l) => str(l, 40)).filter(Boolean)
    : [];
  if (!level && levels.length === 0) return null;
  return { level, levels };
}

/** `models.list` data → its models (unique refs, forge's order), the current one and thinking. */
export function parseModelList(data: unknown): ModelList {
  const list = isObj(data) && Array.isArray(data.available) ? data.available : [];
  const available: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const ref = str(raw.ref, 200);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    available.push({ ref, name: str(raw.name, 120) || ref });
  }
  return {
    available,
    current: isObj(data) ? strOrNull(data.current, 200) : null,
    thinking: isObj(data) ? parseThinking(data.thinking) : null,
  };
}

/** `pin.toggle` data → the pins in effect after it. */
export function parsePinsResult(data: unknown): { pinned: string[]; recent: string[] } | null {
  if (!isObj(data) || !isObj(data.pins)) return null;
  const refs = (v: unknown) => (Array.isArray(v) ? v.map((r) => str(r, 200)).filter(Boolean) : []);
  return { pinned: refs(data.pins.pinned), recent: refs(data.pins.recent) };
}

/**
 * Pinned (saved order), then recent (newest first, never a pin), then every other model. A pin
 * that is not available still shows (it can be unpinned, never picked); empty groups go.
 */
export function modelGroups(
  available: readonly ModelChoice[],
  pins: { pinned: readonly string[]; recent: readonly string[] } | undefined,
): ModelGroup[] {
  const byRef = new Map(available.map((m) => [m.ref, m]));
  const pinned = (pins?.pinned ?? []).map((ref) => byRef.get(ref) ?? { ref, name: ref });
  const pinnedSet = new Set(pinned.map((m) => m.ref));
  const recent = (pins?.recent ?? [])
    .filter((ref) => !pinnedSet.has(ref))
    .map((ref) => byRef.get(ref))
    .filter((m): m is ModelChoice => Boolean(m));
  const shown = new Set([...pinnedSet, ...recent.map((m) => m.ref)]);
  const all = available.filter((m) => !shown.has(m.ref));
  const groups: ModelGroup[] = [
    { key: "pinned", models: pinned },
    { key: "recent", models: recent },
    { key: "all", models: all },
  ];
  return groups.filter((g) => g.models.length > 0);
}

/** `provider/id` of the footer's model. */
export function footerRef(footer: RemoteFooter | null | undefined): string | null {
  const model = footer?.model;
  if (!model || !model.id || model.id === "unknown") return null;
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

// ---------- footer (the desktop status line) ----------

/** 999 → "999", 50000 → "50.0k", 200000 → "200k", 1000000 → "1.0M" (the line's counts). */
export function windowText(n: number): string {
  const abs = Math.abs(n);
  if (abs < 999.5) return String(Math.round(n));
  if (abs < 999_500) return `${abs < 99_950 ? (n / 1000).toFixed(1) : Math.round(n / 1000)}k`;
  return `${abs < 9_950_000 ? (n / 1_000_000).toFixed(1) : Math.round(n / 1_000_000)}M`;
}

/** "$0.0420", "$0.420", "$12.34": the line's amount (formatCost), without its "~". */
export function costText(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0";
  if (cost < 0.1) return `$${cost.toFixed(4)}`;
  if (cost < 10) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** Where the line starts to say "compacts at N%": from 3/4 of the way to the point. */
const HINT_SHARE = 0.75;

export interface FooterPart {
  text: string;
  /** Set on the context field: its colour on the desktop. */
  tone?: ContextTone;
}

function contextPart(footer: RemoteFooter): FooterPart | null {
  const window = footer.contextWindow;
  if (!window || window <= 0) return null;
  if (footer.contextPercent === null || footer.contextTokens === null)
    return footer.compactionPaused ? { text: "compaction paused", tone: "warning" } : null;
  const percent = Math.max(0, Math.round(footer.contextPercent));
  let text = `ctx ${percent}%/${windowText(window)}`;
  if (footer.compactionPaused) text += `${SEP}compaction paused`;
  else if (footer.compactAt !== null) {
    const point = (footer.compactAt / 100) * window;
    if (footer.contextTokens >= HINT_SHARE * point)
      text += `${SEP}compacts at ${footer.compactAt}%`;
  }
  return { text, tone: footer.compactionPaused ? "warning" : footer.contextTone };
}

/**
 * What the desktop status line shows, in its order: model · effort · ctx N%/window (· compacts at,
 * coloured as there) · ~$cost · its items ("1 shell", "◷ wakes in 23m"). Absent fields are left out.
 */
export function footerParts(footer: RemoteFooter | null | undefined): FooterPart[] {
  if (!footer) return [];
  const parts: FooterPart[] = [];
  const model = footer.model;
  if (model && model.id && model.id !== "unknown") {
    parts.push({ text: model.name || model.id });
    if (model.thinking) parts.push({ text: model.thinking });
  }
  const context = contextPart(footer);
  if (context) parts.push(context);
  if (footer.cost !== null) parts.push({ text: `~${costText(footer.cost)}` });
  for (const item of footer.items) parts.push({ text: item });
  return parts;
}

// ---------- /usage, /cost ----------

export interface UsageMeter {
  label: string;
  /** Allowance left, 0–1; null: a plain value with no bar. */
  ratio: number | null;
  value: string;
  detail: string | null;
  resetsAt: number | null;
}

export interface UsageAccount {
  id: string;
  name: string;
  plan: string | null;
  meters: UsageMeter[];
  asOf: number | null;
  problem: string | null;
  empty: string | null;
}

function parseMeter(raw: unknown): UsageMeter | null {
  if (!isObj(raw)) return null;
  const label = str(raw.label, 80);
  if (!label) return null;
  const ratio = num(raw.ratio);
  return {
    label,
    ratio: ratio === null ? null : Math.max(0, Math.min(1, ratio)),
    value: str(raw.value, 120),
    detail: strOrNull(raw.detail, 200),
    resetsAt: num(raw.resetsAt),
  };
}

/** `usage.refresh` data (or the `usage` state) → one block per account, in the panel's order. */
export function parseUsage(data: unknown): UsageAccount[] {
  const list = isObj(data) && Array.isArray(data.accounts) ? data.accounts : [];
  const out: UsageAccount[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const name = str(raw.name, 80);
    if (!name) continue;
    const meters = Array.isArray(raw.meters)
      ? raw.meters.map(parseMeter).filter((m): m is UsageMeter => m !== null)
      : [];
    out.push({
      id: str(raw.id, 40) || name,
      name,
      plan: strOrNull(raw.plan, 60),
      meters,
      asOf: num(raw.asOf),
      problem: strOrNull(raw.problem, 200),
      empty: strOrNull(raw.empty, 200),
    });
  }
  return out;
}

/** `usage.refresh` data → when forge built the snapshot (host clock, epoch ms), if it says. */
export function usageAt(data: unknown): number | null {
  return isObj(data) ? num(data.at) : null;
}

/** "45s", "30m", "2h 13m", "3d 21h" (the CLI's time-left words). */
export function leftWords(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const total = Math.ceil(seconds / 60);
  if (total < 60) return `${total}m`;
  if (total > 24 * 60) {
    const days = Math.floor(total / (24 * 60));
    const hours = Math.floor((total % (24 * 60)) / 60);
    return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
  }
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** The meter's grey line, as the panel draws it: its detail · "Resets in 5h 30m". */
export function meterDetail(meter: UsageMeter, now: number): string {
  let reset: string | null = null;
  if (meter.resetsAt !== null)
    reset = meter.resetsAt <= now ? "Resets now" : `Resets in ${leftWords(meter.resetsAt - now)}`;
  return [meter.detail, reset].filter(Boolean).join(SEP);
}

/** "Claude · Max 20x": the account heading (never who is signed in). */
export function accountHeading(account: UsageAccount): string {
  return account.plan ? `${account.name}${SEP}${account.plan}` : account.name;
}

const UNREACHED = new Set(["timed out", "no connection"]);
const OLD_READING_MS = 120_000;

function shortAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** The note under a heading, as the panel says it; `error` when nothing could be shown. */
export function accountNote(
  account: UsageAccount,
  now: number,
): { text: string; error: boolean } | null {
  const age = account.asOf !== null ? `As of ${shortAge(now - account.asOf)} ago` : null;
  if (account.problem) {
    if (account.meters.length === 0) {
      const text = UNREACHED.has(account.problem)
        ? `Couldn't reach ${account.name}: ${account.problem}`
        : account.problem.charAt(0).toUpperCase() + account.problem.slice(1);
      return { text, error: true };
    }
    return {
      text: `${age ?? "Last known"}${SEP}couldn't refresh: ${account.problem}`,
      error: false,
    };
  }
  if (account.meters.length === 0)
    return { text: account.empty ?? "Nothing to show", error: false };
  if (age && account.asOf !== null && now - account.asOf >= OLD_READING_MS)
    return { text: age, error: false };
  return null;
}

export interface CostRow {
  label: string;
  value: string | null;
  indent: boolean;
}

export interface CostSection {
  title: string | null;
  rows: CostRow[];
}

/** `cost.read` data → pi's Session Info sections, as /cost shows them. */
export function costSections(data: unknown): CostSection[] {
  const list = isObj(data) && Array.isArray(data.sections) ? data.sections : [];
  const out: CostSection[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const rows: CostRow[] = [];
    for (const r of Array.isArray(raw.rows) ? raw.rows : []) {
      if (!isObj(r)) continue;
      const label = str(r.label, 200);
      if (label) rows.push({ label, value: strOrNull(r.value), indent: r.indent === true });
    }
    const title = strOrNull(raw.title, 200);
    if (title || rows.length > 0) out.push({ title, rows });
  }
  return out;
}

// ---------- /pause ----------

export type WakeArgs = { in: number; reason?: string } | { at: number; reason?: string };

/**
 * The /pause sheet's fields → `wake.set` args. Minutes: 1–1440, sent as seconds (forge reads a
 * number `in` as seconds). "14:30" / "2:30pm": the next time the phone's clock reads it, as epoch ms.
 */
export function wakeArgs(
  mode: "in" | "at",
  value: string,
  reason: string,
  now: Date,
): { ok: true; args: WakeArgs } | { ok: false; error: "minutes" | "time" } {
  const why = reason.trim() ? { reason: reason.trim().slice(0, 500) } : {};
  if (mode === "in") {
    const minutes = Number(value.trim());
    if (!value.trim() || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
      return { ok: false, error: "minutes" };
    return { ok: true, args: { in: minutes * 60, ...why } };
  }
  const match = /^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/i.exec(value.trim());
  if (!match) return { ok: false, error: "time" };
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const half = match[3]?.toLowerCase();
  if (half) {
    if (hours < 1 || hours > 12) return { ok: false, error: "time" };
    hours = (hours % 12) + (half === "pm" ? 12 : 0);
  }
  if (hours > 23 || minutes > 59) return { ok: false, error: "time" };
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return { ok: true, args: { at: at.getTime(), ...why } };
}

/** "Wakes at 2:32 PM · in 23m" for the pending wake-up. */
export function wakeWhen(due: number, now: number): { at: string; left: string } {
  const d = new Date(due);
  const h = d.getHours();
  const at = `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  const mins = Math.max(0, Math.round((due - now) / 60_000));
  const left = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return { at, left };
}

// ---------- smaller sheets ----------

/** `export.run` data → the written path. */
export function exportedPath(data: unknown): string | null {
  return isObj(data) ? str(data.path, 1000) || null : null;
}

/** forge refused an export because the file exists (v1.2: reason "exists"). */
export function exportNeedsOverwrite(reason: string | undefined): boolean {
  return reason === "exists";
}

export interface SyncStatus {
  text: string;
  level: "info" | "error";
}

/** `sync.status` data → setup's report and its level. */
export function parseSyncStatus(data: unknown): SyncStatus | null {
  if (!isObj(data) || typeof data.text !== "string") return null;
  return {
    text: multiline(data.text, 64 * 1024) ?? "",
    level: data.level === "error" ? "error" : "info",
  };
}

/** `sync.run` data → whether the sync finished (false: still running; pi reloads after it). */
export function syncDone(data: unknown): boolean {
  return isObj(data) && data.done === true;
}

/** The newest part of the changelog a phone renders at once (forge sends up to 512 KiB). */
export const CHANGELOG_SHOWN = 48_000;

/**
 * `changelog.read` data → its markdown, and whether it was cut (by forge, or here at a release
 * heading so the newest releases render whole).
 */
export function parseChangelog(
  data: unknown,
  max = CHANGELOG_SHOWN,
): { markdown: string; truncated: boolean } {
  if (!isObj(data) || typeof data.markdown !== "string") return { markdown: "", truncated: false };
  const text = multiline(data.markdown, 600_000) ?? "";
  if (text.length <= max) return { markdown: text, truncated: data.truncated === true };
  const cut = text.lastIndexOf("\n## ", max);
  return { markdown: text.slice(0, cut > 0 ? cut : max).trimEnd(), truncated: true };
}

/** A session name for /rename and /branch: one line, at most 200 characters. */
export function sessionName(text: string): string {
  return cleanLine(text, 200).trim();
}

// ---------- /btw ----------

export interface BtwExchange {
  question: string;
  answer: string;
  note?: string;
}

/** `forge-btw` entries since the last `forge-btw-clear`, oldest first, newest 20 (forge's history). */
export function btwHistory(entries: readonly unknown[]): BtwExchange[] {
  const history: BtwExchange[] = [];
  for (const raw of entries) {
    if (!isObj(raw) || raw.type !== "custom") continue;
    if (raw.customType === "forge-btw-clear") {
      history.length = 0;
      continue;
    }
    if (raw.customType !== "forge-btw" || !isObj(raw.data)) continue;
    const { question, answer, note } = raw.data;
    if (typeof question !== "string" || typeof answer !== "string") continue;
    history.push(
      typeof note === "string" && note ? { question, answer, note } : { question, answer },
    );
  }
  return history.slice(-20);
}
