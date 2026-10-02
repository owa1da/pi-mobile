// Session screen chrome decisions. Pure.

import type { SessionRow } from "@/host/types";
import type { ConnectionStatus } from "@/stores/connection-store";

export type SessionTab = "chat" | "terminal";

/**
 * The landscape terminal collapses its chrome (header, sub-bar, system bars) only on the Terminal
 * tab of a handheld held in landscape. Tablets and portrait keep everything.
 */
export function shouldCollapseTerminalChrome(input: {
  tab: SessionTab;
  handheld: boolean;
  width: number;
  height: number;
}): boolean {
  return input.tab === "terminal" && input.handheld && input.width > input.height;
}

export type SubBarStatus =
  | { kind: "state"; key: `pi.session.state.${SessionRow["state"]}` }
  | {
      kind: "connection";
      key: `pi.session.connection.${"connecting" | "reconnecting" | "offline"}`;
    };

/**
 * What the sub-bar says. A session's state is only known while the connection is live; otherwise
 * the last state is stale and the sub-bar names the connection instead.
 */
export function subBarStatus(
  connection: ConnectionStatus,
  rowState: SessionRow["state"],
): SubBarStatus {
  if (connection === "connected") return { kind: "state", key: `pi.session.state.${rowState}` };
  if (connection === "reconnecting")
    return { kind: "connection", key: "pi.session.connection.reconnecting" };
  if (connection === "connecting")
    return { kind: "connection", key: "pi.session.connection.connecting" };
  return { kind: "connection", key: "pi.session.connection.offline" };
}
