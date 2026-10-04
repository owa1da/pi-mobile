// Typed failures of a remote action, each with a short message the UI can show as is. Result codes
// come from forge's result file; the rest are the app's own (no channel, no result in time).

import type { RefusalReason, RemoteResult, ResultCode } from "./types";

const REASONS: ReadonlySet<string> = new Set<RefusalReason>([
  "tui-only",
  "busy",
  "template",
  "skill",
  "gate",
  "not-answerable",
  "not-main",
  "exists",
]);

/** A refused result's `data.reason` (contract v1.1); undefined for older forge builds. */
export function refusalReason(data: unknown): RefusalReason | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const reason = (data as { reason?: unknown }).reason;
  return typeof reason === "string" && REASONS.has(reason) ? (reason as RefusalReason) : undefined;
}

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

  /** forge's machine-readable refusal reason, when it sent one. */
  get reason(): RefusalReason | undefined {
    return this.code === "refused" ? refusalReason(this.result?.data) : undefined;
  }
}

/** A failed result → RemoteError (ok results are not errors). */
/** The fresh command list has no such name: the line is text, so the caller may send it as a message. */
export class CommandUnavailableError extends RemoteError {
  constructor() {
    super("invalid", "That command is not available in this session.");
    this.name = "CommandUnavailableError";
  }
}

export function errorFromResult(result: RemoteResult): RemoteError {
  const code: RemoteErrorCode = result.code === "ok" ? "error" : result.code;
  return new RemoteError(code, result.message, result);
}

export function isRemoteError(error: unknown, code?: RemoteErrorCode): error is RemoteError {
  return error instanceof RemoteError && (code === undefined || error.code === code);
}
