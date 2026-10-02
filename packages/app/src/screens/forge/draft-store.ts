// A prompt handed back to a session's composer (after /rewind restores the conversation, the CLI
// puts the prompt back in pi's editor to edit and send again; the app puts it in its composer).

export interface Prefill {
  text: string;
  /** A new object per hand-back, so the same text twice still fills the field. */
  at: number;
}

const pending = new Map<string, Prefill>();

export function handBack(sessionId: string, text: string): void {
  if (text.trim()) pending.set(sessionId, { text, at: Date.now() });
}

/** The prompt waiting for this session's composer, once. */
export function takeHandBack(sessionId: string): Prefill | undefined {
  const value = pending.get(sessionId);
  pending.delete(sessionId);
  return value;
}
