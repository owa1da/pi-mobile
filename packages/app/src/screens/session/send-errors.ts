// Host-service errors from send/abort/resume → friendly i18n keys. Pure.

import { isOutcomeUnknown, PaneBusyError } from "@/host/errors";
import { HostError } from "@/host/types";
import { isConnectionLostError } from "@/stores/connection-errors";

export interface FriendlyError {
  /** i18n key under pi.session.errors */
  key: string;
  /** Raw detail worth showing (command-failed only). */
  detail?: string;
  /** The fix is in the terminal: offer to switch there. */
  terminal: boolean;
  /**
   * The host never confirmed the result (timeout, dropped mid-run): it may have been sent. Never
   * resend or re-echo automatically; refresh the chat so the user sees what arrived.
   */
  outcomeUnknown?: boolean;
}

const TERMINAL_CODES: ReadonlySet<string> = new Set(["waiting-for-input", "pane-busy"]);

const PANE_BUSY_KEYS: Record<PaneBusyError["reason"], string> = {
  "copy-mode": "pi.session.errors.pane-busy",
  draft: "pi.session.errors.pane-busy-draft",
  "no-prompt": "pi.session.errors.pane-busy-no-prompt",
};

export function friendlyHostError(error: unknown): FriendlyError {
  if (isOutcomeUnknown(error))
    return { key: "pi.session.errors.outcome-unknown", terminal: false, outcomeUnknown: true };
  if (error instanceof PaneBusyError) return { key: PANE_BUSY_KEYS[error.reason], terminal: true };
  if (error instanceof HostError) {
    const terminal = TERMINAL_CODES.has(error.code);
    if (error.code === "command-failed")
      return { key: "pi.session.errors.command-failed", detail: error.message, terminal };
    if (error.code === "tmux-missing" && /3\.2/.test(error.message))
      return { key: "pi.session.errors.tmux-old", terminal: false };
    return { key: `pi.session.errors.${error.code}`, terminal };
  }
  if (isConnectionLostError(error)) return { key: "pi.session.errors.connection", terminal: false };
  const detail = error instanceof Error ? error.message : undefined;
  return { key: "pi.session.errors.command-failed", detail, terminal: false };
}
