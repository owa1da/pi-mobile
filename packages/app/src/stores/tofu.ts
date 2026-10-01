// Trust-on-first-use decisions for SSH host keys. Pure.

export type HostKeyDecision =
  /** Pinned and identical: connect. */
  | { action: "accept" }
  /** The user explicitly approved replacing the pin with exactly this key. */
  | { action: "replace" }
  /** Nothing pinned and a person is present: show the fingerprint and ask. */
  | { action: "ask" }
  | { action: "refuse"; reason: "mismatch" | "unattended-unknown" };

export interface HostKeyDecisionInput {
  pinned: string | undefined;
  presented: string;
  /** A person started this connect (not an automatic reconnect). */
  interactive: boolean;
  /** Set only by the deliberate "Replace pinned key" action, to the fingerprint the user saw. */
  replaceWith?: string;
}

export function decideHostKey(input: HostKeyDecisionInput): HostKeyDecision {
  const { pinned, presented, interactive, replaceWith } = input;
  if (pinned && pinned === presented) return { action: "accept" };
  if (pinned) {
    // Replacing is allowed only for the exact key the user reviewed, never a different one.
    if (interactive && replaceWith === presented) return { action: "replace" };
    return { action: "refuse", reason: "mismatch" };
  }
  if (!interactive) return { action: "refuse", reason: "unattended-unknown" };
  return { action: "ask" };
}

/** Splits "SHA256:abc…" into its algorithm prefix and digest, for display. */
export function splitFingerprint(fingerprint: string): { prefix: string; digest: string } {
  const colon = fingerprint.indexOf(":");
  if (colon <= 0) return { prefix: "", digest: fingerprint };
  return { prefix: fingerprint.slice(0, colon), digest: fingerprint.slice(colon + 1) };
}
