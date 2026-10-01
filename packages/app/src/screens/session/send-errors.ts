// Host-service errors from send/abort/resume → friendly i18n keys. Pure.

import { HostError } from "@/host/types";
import { isConnectionLostError } from "@/stores/connection-errors";

export interface FriendlyError {
  /** i18n key under pi.session.errors */
  key: string;
  /** Raw detail worth showing (command-failed only). */
  detail?: string;
  /** The fix is in the terminal: offer to switch there. */
  terminal: boolean;
}

const TERMINAL_CODES: ReadonlySet<string> = new Set(["waiting-for-input", "pane-busy"]);

export function friendlyHostError(error: unknown): FriendlyError {
  if (error instanceof HostError) {
    const terminal = TERMINAL_CODES.has(error.code);
    if (error.code === "command-failed")
      return { key: "pi.session.errors.command-failed", detail: error.message, terminal };
    return { key: `pi.session.errors.${error.code}`, terminal };
  }
  if (isConnectionLostError(error)) return { key: "pi.session.errors.connection", terminal: false };
  const detail = error instanceof Error ? error.message : undefined;
  return { key: "pi.session.errors.command-failed", detail, terminal: false };
}
