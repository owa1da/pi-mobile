// Typed refinements of the contract's HostError (src/host/types.ts is fixed): same codes, more detail
// for the UI.

import { HostError } from "./types";

export const DRAFT_MESSAGE =
  "This session has an unsent draft on your computer. Send or clear it there first.";

export type PaneBusyReason = "copy-mode" | "draft" | "no-prompt";

/** `pane-busy`, and why: copy mode, a draft in pi's editor, or pi not showing its editor. */
export class PaneBusyError extends HostError {
  constructor(
    public readonly reason: PaneBusyReason,
    message: string,
  ) {
    super("pane-busy", message);
    this.name = "PaneBusyError";
  }
}

/**
 * A mutating command (send, start, resume, abort) whose result never came back: the exec timed out
 * or the connection dropped while it ran. It may or may not have taken effect; never retry it blindly.
 */
export class HostOutcomeUnknownError extends HostError {
  public readonly outcomeUnknown = true;

  constructor(message: string) {
    super("command-failed", message);
    this.name = "HostOutcomeUnknownError";
  }
}

export function isOutcomeUnknown(error: unknown): error is HostOutcomeUnknownError {
  return error instanceof HostOutcomeUnknownError;
}
