// Answer building and validation, checked on the phone before anything is sent (forge checks
// again: the first answer wins and a value must be one of the options).

import type { AskAnswer, AskItem, AskQuestion, RemoteActionArgs, RemotePrompt } from "./types";

/** pi's confirm dialog when forge lists no options of its own. */
export const CONFIRM_OPTIONS = ["Yes", "No"] as const;

/** The rows a select/confirm prompt offers (one tap answers). */
export function promptChoices(prompt: RemotePrompt): string[] {
  if (prompt.kind === "select") return prompt.options ?? [];
  if (prompt.kind === "confirm")
    return prompt.options && prompt.options.length > 0 ? prompt.options : [...CONFIRM_OPTIONS];
  return [];
}

export type PromptReply = { value: string } | { cancel: true };

export type Validation<T> = { ok: true; args: T } | { ok: false; reason: string };

/** prompt.respond args for a reply, or why it cannot be sent. */
export function validatePromptReply(
  prompt: RemotePrompt,
  reply: PromptReply,
): Validation<RemoteActionArgs["prompt.respond"]> {
  if (!prompt.answerable) return { ok: false, reason: "not-answerable" };
  if ("cancel" in reply) return { ok: true, args: { id: prompt.id, cancel: true } };
  if (prompt.kind === "select" || prompt.kind === "confirm") {
    if (!promptChoices(prompt).includes(reply.value)) return { ok: false, reason: "not-an-option" };
    return { ok: true, args: { id: prompt.id, value: reply.value } };
  }
  if (prompt.kind === "input" || prompt.kind === "editor")
    return { ok: true, args: { id: prompt.id, value: reply.value } };
  return { ok: false, reason: "not-answerable" };
}

// ---------- ask_user ----------

/** One question's answer as it is being made: option labels picked and free text. */
export interface ItemDraft {
  picked: string[];
  typed: string;
}

export const emptyDraft = (): ItemDraft => ({ picked: [], typed: "" });

export function emptyDrafts(question: AskQuestion): ItemDraft[] {
  return question.items.map(emptyDraft);
}

/** Tap on an option: single-select replaces (tap again clears), multi-select toggles. */
export function toggleOption(item: AskItem, draft: ItemDraft, label: string): ItemDraft {
  if (!item.options.some((o) => o.label === label)) return draft;
  const has = draft.picked.includes(label);
  if (item.multiSelect)
    return {
      ...draft,
      picked: has ? draft.picked.filter((l) => l !== label) : [...draft.picked, label],
    };
  return { ...draft, picked: has ? [] : [label] };
}

/** A question counts as answered when something is picked or typed. */
export function draftAnswered(draft: ItemDraft | undefined): boolean {
  return Boolean(draft && (draft.picked.length > 0 || draft.typed.trim() !== ""));
}

/** One question's answer for ask.answer: labels in option order, typed text trimmed; null skips. */
export function answerOf(item: AskItem, draft: ItemDraft | undefined): AskAnswer | null {
  if (!draft) return null;
  const picked = item.options.map((o) => o.label).filter((label) => draft.picked.includes(label));
  const kept = item.multiSelect ? picked : picked.slice(0, 1);
  const typed = draft.typed.trim();
  if (kept.length === 0 && !typed) return null;
  return typed ? { picked: kept, typed } : { picked: kept };
}

/**
 * ask.answer args for the whole item, or why it cannot be sent: one entry per question (null =
 * skipped), at least one answered (forge keeps an all-skipped item queued), picks are options.
 */
export function validateAskAnswers(
  question: AskQuestion,
  drafts: readonly (ItemDraft | undefined)[],
): Validation<RemoteActionArgs["ask.answer"]> {
  if (question.status !== "open") return { ok: false, reason: "not-open" };
  const answers = question.items.map((item, i) => answerOf(item, drafts[i]));
  if (answers.every((a) => a === null)) return { ok: false, reason: "nothing-answered" };
  for (const [i, answer] of answers.entries()) {
    if (!answer) continue;
    const item = question.items[i];
    const labels = new Set(item.options.map((o) => o.label));
    if (answer.picked.some((label) => !labels.has(label)))
      return { ok: false, reason: "not-an-option" };
    if (!item.multiSelect && answer.picked.length > 1)
      return { ok: false, reason: "one-option-only" };
  }
  return { ok: true, args: { id: question.id, answers } };
}
