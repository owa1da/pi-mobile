// Error codes shared by the native client (PiSsh module) and the Node test double.
// Keep in sync with SshErrorCodes in modules/pi-ssh/android/.../SshCore.kt.

export const SSH_ERROR_CODES = {
  HOST_KEY_REJECTED: "ERR_SSH_HOST_KEY_REJECTED",
  HOST_KEY_TIMEOUT: "ERR_SSH_HOST_KEY_TIMEOUT",
  AUTH_FAILED: "ERR_SSH_AUTH_FAILED",
  INVALID_KEY: "ERR_SSH_INVALID_KEY",
  CONNECT_FAILED: "ERR_SSH_CONNECT_FAILED",
  TIMEOUT: "ERR_SSH_TIMEOUT",
  NOT_CONNECTED: "ERR_SSH_NOT_CONNECTED",
  CONNECTION_CLOSED: "ERR_SSH_CONNECTION_CLOSED",
  EXEC_FAILED: "ERR_SSH_EXEC_FAILED",
  SHELL_FAILED: "ERR_SSH_SHELL_FAILED",
  OUTPUT_TOO_LARGE: "ERR_SSH_OUTPUT_TOO_LARGE",
  KEYGEN_FAILED: "ERR_SSH_KEYGEN_FAILED",
  INVALID_ARGUMENT: "ERR_SSH_INVALID_ARGUMENT",
  INTERNAL: "ERR_SSH_INTERNAL",
} as const;

export type SshErrorCode = (typeof SSH_ERROR_CODES)[keyof typeof SSH_ERROR_CODES];

export class SshError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SshError";
    this.code = code;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isSshError(error: unknown, code?: SshErrorCode): error is SshError {
  if (!(error instanceof Error)) return false;
  const actual = (error as { code?: unknown }).code;
  if (typeof actual !== "string" || !actual.startsWith("ERR_SSH_")) return false;
  return code === undefined || actual === code;
}

/** Normalizes a native/unknown rejection into an SshError, keeping its code when present. */
export function toSshError(
  error: unknown,
  fallbackCode: string = SSH_ERROR_CODES.INTERNAL,
): SshError {
  if (error instanceof SshError) return error;
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : fallbackCode;
  let message = "SSH error";
  if (error instanceof Error) message = error.message;
  else if (typeof error === "string") message = error;
  return new SshError(code.startsWith("ERR_SSH_") ? code : fallbackCode, message, { cause: error });
}
