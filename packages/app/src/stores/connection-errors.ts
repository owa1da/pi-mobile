// Maps SSH and host-service errors to the connection failures the UI explains. Pure.

import { HostError } from "@/host/types";
import { SSH_ERROR_CODES } from "@/ssh/errors";

export type ConnectionFailureKind =
  | "auth"
  | "invalid-key"
  | "unreachable"
  | "timeout"
  | "host-key-mismatch"
  | "host-key-timeout"
  | "host-key-unverified"
  | "missing-secret"
  | "pi-missing"
  | "tmux-missing"
  | "forge-missing"
  | "lost"
  | "unknown";

export interface ConnectionFailure {
  kind: ConnectionFailureKind;
  message?: string;
  /** host-key-mismatch: what is pinned and what the server presented. */
  pinned?: string;
  presented?: string;
}

/** Failures a retry cannot fix; reconnect stops and waits for the user. */
const FATAL: ReadonlySet<ConnectionFailureKind> = new Set([
  "auth",
  "invalid-key",
  "host-key-mismatch",
  "host-key-unverified",
  "missing-secret",
  "pi-missing",
  "tmux-missing",
  "forge-missing",
]);

export function isFatalFailure(kind: ConnectionFailureKind): boolean {
  return FATAL.has(kind);
}

const SSH_CODE_TO_KIND: Record<string, ConnectionFailureKind> = {
  [SSH_ERROR_CODES.AUTH_FAILED]: "auth",
  [SSH_ERROR_CODES.INVALID_KEY]: "invalid-key",
  [SSH_ERROR_CODES.CONNECT_FAILED]: "unreachable",
  [SSH_ERROR_CODES.TIMEOUT]: "timeout",
  [SSH_ERROR_CODES.HOST_KEY_TIMEOUT]: "host-key-timeout",
  [SSH_ERROR_CODES.NOT_CONNECTED]: "lost",
  [SSH_ERROR_CODES.CONNECTION_CLOSED]: "lost",
};

const HOST_CODE_TO_KIND: Partial<Record<HostError["code"], ConnectionFailureKind>> = {
  "pi-missing": "pi-missing",
  "tmux-missing": "tmux-missing",
  "forge-missing": "forge-missing",
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : undefined;
}

export function classifyConnectionError(error: unknown): ConnectionFailure {
  const message = errorMessage(error);
  if (error instanceof HostError) {
    const kind = HOST_CODE_TO_KIND[error.code] ?? "unknown";
    return { kind, message };
  }
  const code = errorCode(error);
  const kind = (code && SSH_CODE_TO_KIND[code]) || "unknown";
  return { kind, message };
}

/** True when an error from exec/listing means the SSH connection itself is gone. */
export function isConnectionLostError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === SSH_ERROR_CODES.NOT_CONNECTED || code === SSH_ERROR_CODES.CONNECTION_CLOSED)
    return true;
  const message = errorMessage(error) ?? "";
  return (
    message.includes(SSH_ERROR_CODES.NOT_CONNECTED) ||
    message.includes(SSH_ERROR_CODES.CONNECTION_CLOSED)
  );
}

/** i18n key under pi.connect.errors for a failure kind. */
export function failureMessageKey(kind: ConnectionFailureKind): string {
  return `pi.connect.errors.${kind}`;
}
