// Pure view models for the native forge screens: they read an action's `data` defensively (a
// forge build may send more or less than the contract names), group rows as forge's TUI does,
// and format the few numbers the CLI shows. No React, no I/O.

import { cleanLine } from "@/host/procs";
import { multiline } from "./parse";
import type { RemoteCheckpoint, RemoteFooter, RemoteTask } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 500): string => (typeof v === "string" ? cleanLine(v, max) : "");

// ---------- /rewind ----------

export type RewindMode = "both" | "conversation" | "code";

/** The confirm screen's four choices, in the CLI's order (the last one cancels). */
export const REWIND_CHOICES: readonly (RewindMode | "cancel")[] = [
  "both",
  "conversation",
  "code",
  "cancel",
];

export interface RewindPreview {
  files: number;
  added: number;
  removed: number;
  /** forge's own line when it sent one ("4 files changed +21 -2", "No code changes", "! …"). */
  text: string | null;
}

/** `rewind.preview` data → counts (or forge's own line). */
export function parseRewindPreview(data: unknown): RewindPreview | null {
  if (!isObj(data)) return null;
  const text = str(data.text ?? data.summary ?? data.line) || null;
  const files = num(data.files) ?? (Array.isArray(data.files) ? data.files.length : null);
  if (files === null && !text) return null;
  return {
    files: files ?? 0,
    added: num(data.added) ?? 0,
    removed: num(data.removed) ?? 0,
    text,
  };
}

/** The line under a prompt, as `/rewind` words it. */
export function rewindLine(preview: RewindPreview): string {
  if (preview.text) return preview.text;
  if (preview.files <= 0) return "No code changes";
  const counts = [
    preview.added ? `+${preview.added}` : "",
    preview.removed ? `-${preview.removed}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const files = preview.files === 1 ? "1 file changed" : `${preview.files} files changed`;
  return counts ? `${files} ${counts}` : files;
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

/** "2 files changed +21 -2" / "No code changes" for a checkpoint row. */
export function checkpointChange(cp: RemoteCheckpoint): string {
  return rewindLine({ files: cp.files, added: cp.added, removed: cp.removed, text: null });
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

/** Running first (as forge's panel), then the rest, each in forge's order. */
export function taskRows(tasks: readonly RemoteTask[]): RemoteTask[] {
  const running = (t: RemoteTask) => /^(running|working|waiting|queued|starting)/i.test(t.status);
  return [...tasks.filter(running), ...tasks.filter((t) => !running(t))];
}

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

// ---------- /model ----------

export interface ModelChoice {
  ref: string;
  name: string;
}

export interface ModelGroup {
  key: "pinned" | "recent" | "all";
  models: ModelChoice[];
}

/** `models.list` data → its models (unique refs, forge's order). */
export function parseModels(data: unknown): ModelChoice[] {
  const list = isObj(data) && Array.isArray(data.available) ? data.available : [];
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const ref = str(raw.ref, 200);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, name: str(raw.name, 120) || ref });
  }
  return out;
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

/** pi's thinking levels, lowest first. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** `provider/id` of the footer's model. */
export function footerRef(footer: RemoteFooter | null | undefined): string | null {
  const model = footer?.model;
  if (!model || !model.id || model.id === "unknown") return null;
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

// ---------- footer ----------

/** 200000 → "200k", 1000000 → "1.0M" (the status line's context window). */
export function windowText(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** "$0.123", "$1.23", "$12" (the status line's amount). */
export function costText(cost: number): string {
  if (cost >= 10) return `$${cost.toFixed(0)}`;
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(3)}`;
}

/**
 * The status line's items forge publishes, in its order: model · effort · ctx N%/window · cost.
 * Absent items are left out; an "unknown" model is never shown.
 */
export function footerParts(
  footer: RemoteFooter | null | undefined,
  /** The app's short name for the model, when forge sent no display name. */
  fallbackName?: string,
): string[] {
  if (!footer) return [];
  const parts: string[] = [];
  const model = footer.model;
  if (model && model.id && model.id !== "unknown") {
    parts.push(model.name || fallbackName || model.id);
    if (model.thinking) parts.push(model.thinking);
  }
  if (footer.contextPercent !== null) {
    const window = footer.contextWindow ? `/${windowText(footer.contextWindow)}` : "";
    parts.push(`ctx ${Math.round(footer.contextPercent)}%${window}`);
  }
  if (footer.cost !== null) parts.push(costText(footer.cost));
  return parts;
}

// ---------- /usage, /cost ----------

export interface UsageMeter {
  label: string;
  /** Percent left, 0–100, or null when the meter has only a value. */
  left: number | null;
  value: string | null;
  detail: string | null;
}

export interface UsageAccount {
  title: string;
  note: string | null;
  meters: UsageMeter[];
}

function parseMeter(raw: unknown): UsageMeter | null {
  if (!isObj(raw)) return null;
  const label = str(raw.label, 80);
  if (!label) return null;
  const left = num(raw.left ?? raw.percentLeft);
  return {
    label,
    left: left === null ? null : Math.max(0, Math.min(100, Math.floor(left))),
    value: str(raw.value, 120) || null,
    detail: str(raw.detail ?? raw.resets, 160) || null,
  };
}

/** `usage.refresh` data → one block per account, as the /usage panel draws them. */
export function parseUsage(data: unknown): UsageAccount[] {
  const list = isObj(data) && Array.isArray(data.accounts) ? data.accounts : [];
  const out: UsageAccount[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const title = str(raw.title ?? raw.name, 160);
    if (!title) continue;
    const meters = Array.isArray(raw.meters)
      ? raw.meters.map(parseMeter).filter((m): m is UsageMeter => m !== null)
      : [];
    out.push({ title, note: str(raw.note, 300) || null, meters });
  }
  return out;
}

export interface CostRow {
  label: string;
  value: string;
}

/** `cost.read` data → label/value rows (pi's Session Info); else the footer's cost alone. */
export function costRows(data: unknown, footer: RemoteFooter | null | undefined): CostRow[] {
  const rows: CostRow[] = [];
  if (isObj(data) && Array.isArray(data.rows)) {
    for (const raw of data.rows) {
      if (!isObj(raw)) continue;
      const label = str(raw.label, 80);
      if (label) rows.push({ label, value: str(raw.value, 300) });
    }
  } else if (isObj(data) && typeof data.text === "string") {
    for (const line of data.text.split("\n")) {
      const match = /^\s*([^:]{1,60}):\s*(.*)$/.exec(cleanLine(line, 400));
      if (match) rows.push({ label: match[1].trim(), value: match[2].trim() });
    }
  }
  if (rows.length === 0 && footer?.cost !== null && footer?.cost !== undefined)
    rows.push({ label: "Total", value: costText(footer.cost) });
  return rows;
}

// ---------- /pause ----------

export type WakeArgs = { in: number; reason?: string } | { at: number; reason?: string };

/**
 * The /pause sheet's fields → `wake.set` args. Minutes: 1–1440 (forge clamps the same).
 * "14:30" / "2:30pm": the next time the phone's clock reads it, sent as epoch ms.
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
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
      return { ok: false, error: "minutes" };
    return { ok: true, args: { in: minutes, ...why } };
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

/** forge refused an export because the file exists (it asks "Overwrite existing file?"). */
export function exportNeedsOverwrite(message: string | null, data: unknown): boolean {
  if (isObj(data) && (data.exists === true || data.overwrite === true)) return true;
  return /\bexists\b/i.test(message ?? "") && !/symbolic link/i.test(message ?? "");
}

/** `sync.status` / `sync.run` data → its text (setup's report or summary). */
export function syncText(data: unknown): string {
  if (!isObj(data)) return "";
  const text = data.text ?? data.summary ?? data.status;
  if (typeof text === "string") return multiline(text, 8000) ?? "";
  if (Array.isArray(data.lines))
    return data.lines.filter((l): l is string => typeof l === "string").join("\n");
  return "";
}

/** `changelog.read` data → its markdown. */
export function changelogMarkdown(data: unknown): string {
  return isObj(data) && typeof data.markdown === "string"
    ? (multiline(data.markdown, 200_000) ?? "")
    : "";
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
