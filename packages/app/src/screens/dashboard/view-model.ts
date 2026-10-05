// Dashboard view-model: sections, counts, ages, short model, row glyphs. Pure.
// Mirrors forge's sessions page (~/.pi/forge/docs/sessions.md).

import type { SessionModel, SessionRow, SessionSection } from "@/host/types";
import { modelName } from "@/utils/model-name";

export const SECTION_ORDER: readonly SessionSection[] = ["needs", "working", "completed"];
/** Closed rows shown under Completed before "Show N more" (forge's completedShown). */
export const CLOSED_SHOWN = 5;

export interface DashboardSection {
  key: SessionSection;
  data: SessionRow[];
  /** Closed rows hidden behind "Show N more". */
  hiddenCount: number;
}

export function buildSections(rows: readonly SessionRow[], expanded: boolean): DashboardSection[] {
  const sections: DashboardSection[] = [];
  for (const key of SECTION_ORDER) {
    const inSection = rows.filter((row) => row.section === key);
    if (inSection.length === 0) continue;
    if (key !== "completed" || expanded) {
      sections.push({ key, data: inSection, hiddenCount: 0 });
      continue;
    }
    const open = inSection.filter((row) => row.live);
    const closed = inSection.filter((row) => !row.live);
    const shown = closed.slice(0, CLOSED_SHOWN);
    sections.push({
      key,
      data: [...open, ...shown],
      hiddenCount: closed.length - shown.length,
    });
  }
  return sections;
}

export interface CountPart {
  section: SessionSection;
  count: number;
}

/** The header's counts, in section order, leaving out empty sections. */
export function countParts(counts: Record<SessionSection, number>): CountPart[] {
  return SECTION_ORDER.map((section) => ({ section, count: counts[section] ?? 0 })).filter(
    (part) => part.count > 0,
  );
}

const hostClocks = new Map<string, number>();
/**
 * Host seconds that never step back for a late listing (sampled before a slow reply), so ages only
 * count up. A backward jump of 30 s or more is a real clock change and is taken as is.
 */
export function steadyHostNow(hostId: string, hostNowSec: number): number {
  const last = hostClocks.get(hostId);
  const next =
    last !== undefined && hostNowSec < last && last - hostNowSec < 30 ? last : hostNowSec;
  hostClocks.set(hostId, next);
  return next;
}
/** Tests: forget every host's clock. */
export function resetHostClocks(): void {
  hostClocks.clear();
}

/** Compact age against the host clock: 41s, 5m, 3h, 2d. */
export function formatAge(sinceMs: number, hostNowSec: number): string {
  const seconds = Math.max(0, Math.floor(hostNowSec - sinceMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const MODEL_MAX = 20;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const isUnknownWord = (value: string | undefined) => {
  const word = (value ?? "").trim().toLowerCase();
  return word === "" || word === "unknown";
};

/** pi reports `unknown` before a model is chosen (no auth yet): say nothing rather than "Unknown". */
function isUnknownModel(model: SessionModel): boolean {
  return isUnknownWord(model.id) && isUnknownWord(model.name);
}

/** forge's short model name (`Opus 5.5`, `GLM 5.3 Flash`; see utils/model-name), ≤ 20 chars. */
export function shortModel(model: SessionModel | undefined): string | undefined {
  if (!model || isUnknownModel(model)) return undefined;
  const base = modelName({ id: model.id, name: model.name });
  return base ? truncate(base, MODEL_MAX) : undefined;
}

export type GlyphKind =
  | "needs"
  | "working"
  | "scheduled"
  | "live"
  | "closed"
  | "failed"
  | "interrupted"
  | "gone";

function completedGlyph(row: SessionRow): GlyphKind {
  const detail = row.detail ?? "";
  if (detail.startsWith("error:")) return "failed";
  if (detail === "interrupted") return "interrupted";
  if (row.live) return "live";
  return row.endReason === "gone" ? "gone" : "closed";
}

/** The row's state glyph (forge's ✻ / spinner / ◷ / ∙ family); the only per-row status shown. */
export function rowGlyph(row: SessionRow): GlyphKind {
  if (row.section === "needs") return "needs";
  if (row.section === "working") return row.wake && !row.wake.missed ? "scheduled" : "working";
  return completedGlyph(row);
}
