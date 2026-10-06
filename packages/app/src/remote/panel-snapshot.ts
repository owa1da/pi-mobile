// Display-only host snapshots. These files never provide actions, gates, or channel identity.
import { utf8ByteLength } from "@/host/encoding";

export type HostPanel = "usage" | "changelog";
export const PANEL_MAX_BYTES: Readonly<Record<HostPanel, number>> = {
  usage: 64 * 1024,
  changelog: 512 * 1024,
};
export interface PanelSnapshot {
  v: 1;
  at: number;
  data: unknown;
}
export function isHostPanel(name: string): name is HostPanel {
  return name === "usage" || name === "changelog";
}
export function parsePanelSnapshot(
  text: string | null | undefined,
  name: HostPanel,
): PanelSnapshot | undefined {
  const cap = PANEL_MAX_BYTES[name];
  if (typeof text !== "string" || text.length > cap || utf8ByteLength(text) > cap) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !object(raw) ||
    raw.v !== 1 ||
    typeof raw.at !== "number" ||
    !Number.isSafeInteger(raw.at) ||
    raw.at < 0 ||
    raw.at > 8.64e15 ||
    !object(raw.data)
  )
    return undefined;
  if (name === "usage" ? !Array.isArray(raw.data.accounts) : typeof raw.data.markdown !== "string")
    return undefined;
  return { v: 1, at: raw.at, data: raw.data };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
