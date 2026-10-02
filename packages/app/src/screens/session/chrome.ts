// Session screen chrome decisions. Pure.

import type { SessionRow } from "@/host/types";
import type { ConnectionStatus } from "@/stores/connection-store";

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
