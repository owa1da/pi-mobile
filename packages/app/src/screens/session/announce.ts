// What the screen reader hears on live updates: once per new final reply, once per connection
// change, never per spinner frame or per intermediate tool step. Pure, so it is unit tested.

import type { ChatRow } from "./chat-rows";

export interface ReplyRef {
  key: string;
  text: string;
}

/** The newest completed assistant reply, or null. */
export function latestReply(rows: readonly ChatRow[]): ReplyRef | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind !== "assistant") continue;
    if (row.phase !== "complete") return null;
    return { key: row.key, text: row.text };
  }
  return null;
}

/** First words of a reply for the announcement: markdown marks dropped, whitespace folded. */
export function previewText(text: string, max = 140): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Decides whether a reply is announced. The first reply seen is the baseline (opening a chat
 * never reads the old answer); while pi is still working the baseline is not moved, so a turn
 * with several tool steps is announced once, when its final reply lands.
 */
export function nextReplyAnnouncement(
  baseline: string | null | undefined,
  latest: ReplyRef | null,
  working: boolean,
): { baseline: string | null | undefined; announce: ReplyRef | null } {
  if (baseline === undefined) return { baseline: latest?.key ?? null, announce: null };
  if (working || !latest || latest.key === baseline) return { baseline, announce: null };
  return { baseline: latest.key, announce: latest };
}

export type ConnectionPhase = "connected" | "reconnecting" | "failed" | "other";

/** Connection words to announce: a drop, a failure and a recovery, each once. */
export function connectionAnnouncement(
  previous: ConnectionPhase,
  current: ConnectionPhase,
): "reconnecting" | "failed" | "restored" | null {
  if (previous === current) return null;
  if (current === "reconnecting") return "reconnecting";
  if (current === "failed") return "failed";
  if (current === "connected" && (previous === "reconnecting" || previous === "failed"))
    return "restored";
  return null;
}
