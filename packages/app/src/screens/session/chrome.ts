// Session screen chrome decisions. Pure.

import type { SessionRow } from "@/host/types";
import type { RemoteState } from "@/remote/types";
import type { ConnectionStatus } from "@/stores/connection-store";

/** What the session's remote channel knows (see use-remote-channel). */
export interface ChannelView {
  available: boolean;
  loaded: boolean;
  state: RemoteState | undefined;
}

/**
 * The passive "pi is asking" banner, for a waiting session the app cannot answer: no remote
 * channel, an unreadable state, or a dialog on screen the channel does not describe. Once the
 * channel has loaded it is trusted over the listing (polled every 2 s): right after an answer the
 * row still says waiting while the channel already shows nothing open, and the banner must not
 * flash back. Never while the channel is still loading (the dock is about to show).
 */
export function waitingBannerVisible(rowState: SessionRow["state"], channel: ChannelView): boolean {
  if (rowState !== "waiting") return false;
  if (!channel.available) return true;
  if (!channel.loaded) return false;
  const state = channel.state;
  if (!state) return true;
  if (state.prompt) return false;
  if ((state.questions ?? []).some((q) => q.status === "open")) return false;
  return state.view === "dialog";
}

/**
 * The footer under the composer is forge's status line and nothing else (status-line.md): no state
 * word. While the connection is not live its facts are stale, so they are drawn dimmed.
 */
export function footerDimmed(connection: ConnectionStatus): boolean {
  return connection !== "connected";
}

/**
 * The answer dock holds the input's place: pi's dialog, or an ask item that blocks pi. forge draws
 * no status line then ("while a panel has the input's place … there is no line"), and no working
 * row while an ask_user question keeps the agent waiting on you (look.md).
 */
export function inputHeld(state: RemoteState | undefined): boolean {
  if (!state) return false;
  if (state.prompt) return true;
  return (state.questions ?? []).some((q) => q.status === "open" && q.blocking);
}

/**
 * pi's working row (look.md "The working row"): shown while pi runs a turn, above the input, never
 * while the dock holds the input or while the connection is not live (the state would be stale).
 */
export function workingRowVisible(
  rowState: SessionRow["state"],
  connection: ConnectionStatus,
  held: boolean,
): boolean {
  return rowState === "working" && connection === "connected" && !held;
}

/** The working row's clock, as forge writes it: `4s`, `1m 14s`, `1h 2m`. */
export function workingClock(sinceMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** A part of the footer line, measured: forge's footer kinds. */
export type LineKind = "thinking" | "model" | "cost" | "context" | "item";

export interface MeasuredPart {
  kind: LineKind;
  width: number;
}

/**
 * forge's `LINE_DROP_ORDER` (`_lib/status-line/format.ts`) for the parts it sends: effort, model,
 * cost, context, then the items (right-most first).
 */
export const LINE_DROP_ORDER: readonly LineKind[] = [
  "thinking",
  "model",
  "cost",
  "context",
  "item",
];

/** A part shown only next to a part of another kind (the effort with its model). */
const FOLLOWS: Partial<Record<LineKind, LineKind>> = { thinking: "model" };

/** The width of `parts` on one line, joined by a separator of `sepWidth`. */
export function lineWidth(parts: readonly MeasuredPart[], sepWidth: number): number {
  return parts.reduce((sum, part, at) => sum + part.width + (at > 0 ? sepWidth : 0), 0);
}

/**
 * forge's `fitLine`: the line never wraps and never cuts a part in half. When the parts do not fit
 * `room`, they go whole in `LINE_DROP_ORDER` (the right-most of a kind first) until the line fits;
 * then each dropped part that fits again in the room left comes back, the most important first.
 * When even the most important part alone is wider than `room`, it stays alone and the caller cuts
 * it with `…`.
 */
export function fitLine<T extends MeasuredPart>(
  parts: readonly T[],
  room: number,
  sepWidth: number,
): T[] {
  const fits = (list: readonly T[]) => lineWidth(list, sepWidth) <= room;
  if (fits(parts)) return [...parts];
  const kept = new Set(parts.map((_, at) => at));
  const line = () =>
    parts.filter((part, at) => {
      if (!kept.has(at)) return false;
      const follows = FOLLOWS[part.kind];
      return follows === undefined || parts.some((o, i) => o.kind === follows && kept.has(i));
    });
  const dropped: number[] = [];
  for (const kind of LINE_DROP_ORDER) {
    for (let at = parts.length - 1; at >= 0 && !fits(line()); at--) {
      if (parts[at]!.kind === kind && kept.has(at)) {
        kept.delete(at);
        dropped.push(at);
      }
    }
    if (fits(line())) break;
  }
  if (line().length === 0) {
    const lone = dropped.findLast((at) => FOLLOWS[parts[at]!.kind] === undefined);
    if (lone !== undefined) {
      kept.add(lone);
      return line();
    }
  }
  for (const at of dropped.toReversed()) {
    kept.add(at);
    if (!fits(line())) kept.delete(at);
  }
  return line();
}
