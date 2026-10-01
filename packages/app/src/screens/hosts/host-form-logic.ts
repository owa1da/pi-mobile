// Host form: which secret to save, and whether an edit needs a fresh connection. Pure.

import type { HostDraft, HostSecret } from "@/stores/host-records";
import type { SavedHost } from "@/host/types";

export type AuthMode = "generate" | "paste" | "password";

export interface SecretInput {
  mode: AuthMode;
  /** The secret already saved for this host (edit), if any. */
  existing: HostSecret | null;
  generated: { privateKey: string; publicKey: string } | null;
  pastedKey: string;
  passphrase: string;
  password: string;
}

/** `secret` undefined = keep the saved one. */
export type SecretResult = { ok: true; secret?: HostSecret } | { ok: false };

function sameGenerated(
  existing: HostSecret | null,
  generated: { privateKey: string; publicKey: string },
): boolean {
  return existing?.kind === "generated" && existing.privateKey === generated.privateKey;
}

function pastedSecret(input: SecretInput): SecretResult {
  const key = input.pastedKey.trim();
  if (key) {
    const privateKey = `${key}\n`;
    const passphrase = input.passphrase;
    return {
      ok: true,
      secret: passphrase
        ? { kind: "pasted", privateKey, passphrase }
        : { kind: "pasted", privateKey },
    };
  }
  if (input.existing?.kind !== "pasted") return { ok: false };
  // Same key, maybe a new passphrase.
  if (!input.passphrase) return { ok: true };
  return {
    ok: true,
    secret: { kind: "pasted", privateKey: input.existing.privateKey, passphrase: input.passphrase },
  };
}

export function resolveSecret(input: SecretInput): SecretResult {
  if (input.mode === "generate") {
    if (!input.generated) return { ok: false };
    if (sameGenerated(input.existing, input.generated)) return { ok: true };
    return { ok: true, secret: { kind: "generated", ...input.generated } };
  }
  if (input.mode === "paste") return pastedSecret(input);
  if (input.password) return { ok: true, secret: { kind: "password", password: input.password } };
  return input.existing?.kind === "password" ? { ok: true } : { ok: false };
}

export function modeOf(secret: HostSecret | null, fallback: AuthMode): AuthMode {
  if (!secret) return fallback;
  if (secret.kind === "generated") return "generate";
  return secret.kind === "pasted" ? "paste" : "password";
}

/** An edit that changes where or how we sign in must drop the live connection. */
export function needsReconnect(
  before: SavedHost,
  draft: HostDraft,
  secretChanged: boolean,
): boolean {
  return (
    secretChanged ||
    before.host !== draft.host.trim() ||
    before.port !== draft.port ||
    before.username !== draft.username.trim()
  );
}
