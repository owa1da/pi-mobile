// Typed failures of a remote action, each with a short message the UI can show as is. Result codes
// come from forge's result file; the rest are the app's own (no channel, no result in time).

import type { RemoteResult, ResultCode } from "./types";

export type RemoteErrorCode =
  | Exclude<ResultCode, "ok">
  /** The process has no inbox (forge without the channel, or pi just exited). */
  | "no-channel"
  /** No result within the wait: the action may or may not have run. */
  | "timeout"
  /** The host command itself failed (SSH, shell). */
  | "transport";

/** i18n keys (pi.remote.errors.*) per code. */
export const REMOTE_ERROR_KEYS: Record<RemoteErrorCode, string> = {
  stale: "pi.remote.errors.stale",
  expired: "pi.remote.errors.expired",
  invalid: "pi.remote.errors.invalid",
  refused: "pi.remote.errors.refused",
  "unknown-action": "pi.remote.errors.unknown-action",
  error: "pi.remote.errors.error",
  "no-channel": "pi.remote.errors.no-channel",
  timeout: "pi.remote.errors.timeout",
  transport: "pi.remote.errors.transport",
};

/** English fallbacks (the same words as en.ts), for logs and non-UI callers. */
const FRIENDLY: Record<RemoteErrorCode, string> = {
  stale: "Already answered",
  expired: "That took too long to reach your computer. Try again.",
  invalid: "pi did not accept that answer.",
  refused: "pi cannot do that right now.",
  "unknown-action": "Update forge on your computer to use this",
  error: "Something went wrong on your computer.",
  "no-channel": "This session cannot be answered from the app. Update forge on your computer.",
  timeout: "Your computer did not confirm in time. Check the chat before trying again.",
  transport: "Could not reach your computer.",
};

export class RemoteError extends Error {
  constructor(
    public readonly code: RemoteErrorCode,
    /** forge's own message (refused/invalid/error), shown under the friendly line when useful. */
    public readonly detail: string | null = null,
    public readonly result?: RemoteResult,
  ) {
    super(detail ? `${FRIENDLY[code]} (${detail})` : FRIENDLY[code]);
    this.name = "RemoteError";
  }

  /** The friendly line for this code. */
  get friendly(): string {
    return FRIENDLY[this.code];
  }

  get i18nKey(): string {
    return REMOTE_ERROR_KEYS[this.code];
  }
}

/** A failed result → RemoteError (ok results are not errors). */
export function errorFromResult(result: RemoteResult): RemoteError {
  const code: RemoteErrorCode = result.code === "ok" ? "error" : result.code;
  return new RemoteError(code, result.message, result);
}

export function isRemoteError(error: unknown, code?: RemoteErrorCode): error is RemoteError {
  return error instanceof RemoteError && (code === undefined || error.code === code);
}
