// forge's state glyphs and the words that carry the same state for screen readers. Pure.
// The goal: a row's state reads without colour (shape + section + label) and without motion
// (Reduce Motion swaps the spinner for a distinct static shape, never the needs-input ✻).

import type { SessionRow } from "@/host/types";
import type { GlyphKind } from "./view-model";

/** forge's working spinner, 5 fps. */
export const WORKING_FRAMES = ["·", "✢", "*", "✶", "✻", "✽", "✻", "✶", "*", "✢"] as const;

/** Under Reduce Motion the working glyph is ✢: still, and a different shape from needs-input ✻. */
export const WORKING_STATIC = "✢";

const STATIC: Record<Exclude<GlyphKind, "working">, string> = {
  needs: "✻",
  scheduled: "◷",
  live: "✻",
  // Closed rows use a filled dot drawn smaller (see session-glyph): forge's ∙ is too light to
  // hold its own next to ✻ in Android's monospace fallback.
  closed: "●",
  failed: "●",
  interrupted: "●",
  gone: "●",
};

/** The glyph to draw. `frame` is the shared spinner tick; ignored when motion is reduced. */
export function glyphFor(kind: GlyphKind, reducedMotion: boolean, frame = 0): string {
  if (kind !== "working") return STATIC[kind];
  if (reducedMotion) return WORKING_STATIC;
  return WORKING_FRAMES[
    ((frame % WORKING_FRAMES.length) + WORKING_FRAMES.length) % WORKING_FRAMES.length
  ];
}

/** Dot glyphs are drawn a step smaller so their ink matches the asterisk family. */
export function isDotGlyph(kind: GlyphKind): boolean {
  return kind === "closed" || kind === "failed" || kind === "interrupted" || kind === "gone";
}

export type RowStateWord = "needs" | "working" | "completed" | "closed";

/** The state word every row announces: needs input / working / completed / closed. */
export function rowStateWord(row: Pick<SessionRow, "section" | "live">): RowStateWord {
  if (row.section === "needs") return "needs";
  if (row.section === "working") return "working";
  return row.live ? "completed" : "closed";
}

/** title, state, status, age — empty parts dropped, comma-joined for TalkBack/VoiceOver. */
export function rowAccessibilityLabel(parts: {
  title: string;
  state: string;
  status?: string;
  meta?: string;
  age?: string;
}): string {
  return [parts.title, parts.state, parts.status, parts.meta, parts.age]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
}
