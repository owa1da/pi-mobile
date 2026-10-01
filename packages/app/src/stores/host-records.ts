// Saved host records and their secrets. Pure: no React Native, no storage.
// A record (SavedHost) never carries secret material; secrets live under `secretRef`.

import type { SavedHost } from "@/host/types";
import type { SshAuth } from "@/ssh/types";

/** Secret material stored in secure storage under `SavedHost.secretRef`. */
export type HostSecret =
  | { kind: "generated"; privateKey: string; publicKey: string }
  | { kind: "pasted"; privateKey: string; passphrase?: string }
  | { kind: "password"; password: string };

export type HostSecretKind = HostSecret["kind"];

export interface HostDraft {
  label: string;
  host: string;
  port: number;
  username: string;
}

export type HostDraftError = "host-required" | "username-required" | "port-invalid";

export const DEFAULT_SSH_PORT = 22;

export function secretToAuth(secret: HostSecret): SshAuth {
  if (secret.kind === "password") return { type: "password", password: secret.password };
  const passphrase = secret.kind === "pasted" ? secret.passphrase : undefined;
  return passphrase
    ? { type: "key", privateKey: secret.privateKey, passphrase }
    : { type: "key", privateKey: secret.privateKey };
}

export function authTypeOf(secret: HostSecret): SavedHost["authType"] {
  return secret.kind === "password" ? "password" : "key";
}

/** Parses a port field; returns null for anything that is not 1–65535. */
export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return DEFAULT_SSH_PORT;
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

export function validateDraft(draft: HostDraft): HostDraftError[] {
  const errors: HostDraftError[] = [];
  if (!draft.host.trim()) errors.push("host-required");
  if (!draft.username.trim()) errors.push("username-required");
  if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535)
    errors.push("port-invalid");
  return errors;
}

export function normalizeDraft(draft: HostDraft): HostDraft {
  const host = draft.host.trim();
  return {
    label: draft.label.trim() || host,
    host,
    port: draft.port,
    username: draft.username.trim(),
  };
}

/** The connection identity changed: a pinned host key no longer applies. */
export function changesIdentity(before: SavedHost, after: HostDraft): boolean {
  return before.host !== after.host.trim() || before.port !== after.port;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Rebuilds a record from untrusted JSON, keeping only known non-secret fields. */
export function sanitizeRecord(value: unknown): SavedHost | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isString(v.id) || !isString(v.host) || !isString(v.username) || !isString(v.secretRef))
    return null;
  if (typeof v.port !== "number" || (v.authType !== "key" && v.authType !== "password"))
    return null;
  const record: SavedHost = {
    id: v.id,
    label: isString(v.label) ? v.label : v.host,
    host: v.host,
    port: v.port,
    username: v.username,
    authType: v.authType,
    secretRef: v.secretRef,
    createdAt: optionalNumber(v.createdAt) ?? 0,
  };
  if (isString(v.hostKeyFingerprint)) record.hostKeyFingerprint = v.hostKeyFingerprint;
  const last = optionalNumber(v.lastConnectedAt);
  if (last !== undefined) record.lastConnectedAt = last;
  return record;
}

export function serializeRecords(records: readonly SavedHost[]): string {
  return JSON.stringify(records.map((record) => sanitizeRecord(record)).filter(Boolean));
}

export function parseRecords(json: string | null): SavedHost[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeRecord).filter((r): r is SavedHost => r !== null);
  } catch {
    return [];
  }
}

export function parseSecret(json: string | null): HostSecret | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (v.kind === "password" && isString(v.password))
      return { kind: "password", password: v.password };
    if (v.kind === "generated" && isString(v.privateKey) && isString(v.publicKey))
      return { kind: "generated", privateKey: v.privateKey, publicKey: v.publicKey };
    if (v.kind === "pasted" && isString(v.privateKey))
      return isString(v.passphrase) && v.passphrase
        ? { kind: "pasted", privateKey: v.privateKey, passphrase: v.passphrase }
        : { kind: "pasted", privateKey: v.privateKey };
    return null;
  } catch {
    return null;
  }
}

/** `user@host` with the port only when it is not 22. */
export function hostAddress(host: Pick<SavedHost, "host" | "port" | "username">): string {
  const base = `${host.username}@${host.host}`;
  return host.port === DEFAULT_SSH_PORT ? base : `${base}:${host.port}`;
}
