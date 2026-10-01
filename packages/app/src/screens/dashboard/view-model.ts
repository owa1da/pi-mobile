// Dashboard view-model: sections, counts, ages, short model and folder, row glyphs. Pure.
// Mirrors forge's sessions page (~/.pi/forge/docs/sessions.md).

import type { SessionModel, SessionRow, SessionSection } from "@/host/types";

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

function titleCaseId(id: string): string {
  const last = id.split("/").pop() ?? id;
  return last
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** pi's display name without "Vendor: " or "Claude ", else the id read as words; ≤ 20 chars. */
export function shortModel(model: SessionModel | undefined): string | undefined {
  if (!model) return undefined;
  const name = model.name?.trim();
  const base = name
    ? name.replace(/^[^:]{1,40}:\s*/, "").replace(/^Claude\s+/i, "")
    : titleCaseId(model.id);
  return base ? truncate(base, MODEL_MAX) : undefined;
}

/** Home-shortened folder cut to its last two names: ~/llm-stack, …/repo/api. */
export function shortFolder(cwd: string, homeDir: string | undefined): string {
  if (!cwd) return "";
  let path = cwd;
  if (homeDir && (cwd === homeDir || cwd.startsWith(`${homeDir}/`)))
    path = `~${cwd.slice(homeDir.length)}`;
  const parts = path.split("/").filter(Boolean);
  if (path.startsWith("~") && parts.length <= 3) return path;
  if (!path.startsWith("~") && parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
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

export interface RowPresentation {
  glyph: GlyphKind;
  /** Grey status text shown under the title, when it says something the title cannot. */
  status?: string;
  /** The status is the question pi is asking. */
  asking: boolean;
}

function completedGlyph(row: SessionRow): GlyphKind {
  const detail = row.detail ?? "";
  if (detail.startsWith("error:")) return "failed";
  if (detail === "interrupted") return "interrupted";
  if (row.live) return "live";
  return row.endReason === "gone" ? "gone" : "closed";
}

export function presentRow(row: SessionRow): RowPresentation {
  if (row.section === "needs") {
    if (row.asking) return { glyph: "needs", status: row.asking, asking: true };
    return { glyph: "needs", status: row.detail, asking: false };
  }
  if (row.section === "working")
    return { glyph: row.wake && !row.wake.missed ? "scheduled" : "working", asking: false };
  const glyph = completedGlyph(row);
  const showDetail = glyph === "failed" || glyph === "interrupted";
  return { glyph, status: showDetail ? row.detail : undefined, asking: false };
}
