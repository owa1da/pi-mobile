// The bottom of the session screen: pi's open dialog replaces the composer (pi's TUI swaps its
// editor for the dialog the same way); an ask_user item sits above the composer, or replaces it
// while it blocks pi. Docked, never modal: the chat above keeps the message being asked about.

import { useCallback, useMemo, type ReactNode } from "react";
import { AskPanel, PromptPanel } from "@/components/pi/answer-panel";
import { validatePromptReply, type PromptReply } from "@/remote/answers";
import { openQuestions } from "@/remote/parse";
import type { RemoteActionArgs } from "@/remote/types";
import type { useAnswers } from "./use-answers";
import type { RemoteChannel } from "./use-remote-channel";

interface AnswerDockProps {
  channel: RemoteChannel;
  answers: ReturnType<typeof useAnswers>;
  /** The composer, shown when nothing blocks it. */
  children: ReactNode;
}

export function AnswerDock({ channel, answers, children }: AnswerDockProps) {
  const prompt = channel.state?.prompt ?? null;
  const questions = useMemo(() => openQuestions(channel.state), [channel.state]);
  const question = questions[0];
  const { run, status } = answers;

  const respond = useCallback(
    (reply: PromptReply) => {
      if (!prompt) return;
      const checked = validatePromptReply(prompt, reply);
      if (!checked.ok) return;
      void run(
        prompt.id,
        "prompt.respond",
        checked.args,
        "value" in reply ? reply.value : undefined,
      );
    },
    [prompt, run],
  );
  const answer = useCallback(
    (args: RemoteActionArgs["ask.answer"]) => {
      void run(args.id, "ask.answer", args);
    },
    [run],
  );
  const questionId = question?.id;
  const dismiss = useCallback(() => {
    if (questionId) void run(questionId, "ask.dismiss", { id: questionId });
  }, [questionId, run]);

  if (prompt)
    return (
      <PromptPanel key={prompt.id} prompt={prompt} status={status[prompt.id]} onRespond={respond} />
    );
  return (
    <>
      {question ? (
        <AskPanel
          key={question.id}
          question={question}
          position={1}
          total={questions.length}
          status={status[question.id]}
          onAnswer={answer}
          onDismiss={dismiss}
        />
      ) : null}
      {question?.blocking ? null : children}
    </>
  );
}

/** The ids of the open dialog and ask items (answer statuses are kept for these only). */
export function openIdsOf(channel: RemoteChannel): string[] {
  const ids = openQuestions(channel.state).map((q) => q.id);
  const prompt = channel.state?.prompt;
  return prompt ? [prompt.id, ...ids] : ids;
}
