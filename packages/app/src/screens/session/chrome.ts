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

export type SubBarStatus =
  | { kind: "state"; key: `pi.session.state.${SessionRow["state"]}` }
  /** An optimistic send is in flight: the spinner in the composer and this word agree. */
  | { kind: "pending"; key: "pi.session.state.sending" }
  | {
      kind: "connection";
      key: `pi.session.connection.${"connecting" | "offline"}`;
    }
  /** The connection banner is up and already says it: the sub-bar shows identity only. */
  | { kind: "quiet" };

/**
 * What the sub-bar says. A session's state is only known while the connection is live; while a
 * reconnecting/failed banner is showing the sub-bar does not repeat it (no state word at all).
 */
export function subBarStatus(
  connection: ConnectionStatus,
  rowState: SessionRow["state"],
  sending = false,
): SubBarStatus {
  if (connection === "connected") {
    if (sending && rowState !== "working" && rowState !== "waiting")
      return { kind: "pending", key: "pi.session.state.sending" };
    return { kind: "state", key: `pi.session.state.${rowState}` };
  }
  if (connection === "reconnecting" || connection === "failed") return { kind: "quiet" };
  if (connection === "connecting")
    return { kind: "connection", key: "pi.session.connection.connecting" };
  return { kind: "connection", key: "pi.session.connection.offline" };
}
