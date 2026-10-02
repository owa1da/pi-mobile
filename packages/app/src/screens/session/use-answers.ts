// Answering pi from the session screen: one action in flight per dialog/question, an optimistic
// "Sent" the moment it is tapped (kept until the item leaves the state), a calm notice when the
// desktop answered first (stale), and an inline error otherwise so the user can try again.

import { useCallback, useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { isRemoteError, RemoteError } from "@/remote/errors";
import type { RemoteAction, ArgsOf } from "@/remote/types";
import type { AnswerStatus } from "@/components/pi/answer-panel";
import type { RemoteChannel } from "./use-remote-channel";

const NOTICE_MS = 6000;

export interface Notice {
  text: string;
  testID: string;
}

/**
 * forge's own reason, shown under the friendly line for refused/error only. The app has no
 * terminal, so a reason that talks about one (or its actions) is left out.
 */
export function remoteDetail(error: RemoteError): string | undefined {
  if (error.code !== "refused" && error.code !== "error") return undefined;
  const detail = error.detail?.trim();
  if (!detail || /terminal|\b[a-z]+\.[a-z]+\b/i.test(detail)) return undefined;
  return detail;
}

/** A failed remote action as the send-error banner's key + detail. */
export function friendlyRemote(error: unknown): { key: string; detail?: string } {
  if (!(error instanceof RemoteError)) return { key: "pi.remote.errors.transport" };
  const detail = remoteDetail(error);
  return detail ? { key: error.i18nKey, detail: `(${detail})` } : { key: error.i18nKey };
}

/** The words for a failed remote action: the friendly line, plus forge's reason when it helps. */
export function remoteMessage(t: TFunction, error: unknown): string {
  if (!(error instanceof RemoteError)) return t("pi.remote.errors.transport");
  const line = t(error.i18nKey);
  const detail = remoteDetail(error);
  return detail ? `${line} (${detail})` : line;
}

/** A transient notice (stale, coming soon): dismissible, gone by itself after a few seconds. */
export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const dismiss = useCallback(() => setNotice(null), []);
  return { notice, show: setNotice, dismiss };
}

export function useAnswers(
  channel: RemoteChannel,
  openIds: readonly string[],
  t: TFunction,
  showNotice: (notice: Notice) => void,
) {
  const [status, setStatus] = useState<Record<string, AnswerStatus>>({});
  const inFlight = useRef(new Set<string>());
  const openKey = openIds.join("\n");

  // Forget the status of items that left the state (answered, here or on the desktop).
  useEffect(() => {
    const open = new Set(openKey ? openKey.split("\n") : []);
    setStatus((prev) => {
      const kept = Object.entries(prev).filter(([id]) => open.has(id));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
  }, [openKey]);

  const run = useCallback(
    async <A extends RemoteAction>(id: string, action: A, args: ArgsOf<A>, picked?: string) => {
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      setStatus((prev) => ({ ...prev, [id]: { sent: true, picked } }));
      try {
        await channel.send(action, args);
      } catch (error) {
        if (isRemoteError(error, "stale")) {
          // Someone answered on the computer first: the item closes with the next read.
          showNotice({ text: t("pi.remote.stale"), testID: "answer-stale" });
        } else {
          setStatus((prev) => ({ ...prev, [id]: { sent: false, error: remoteMessage(t, error) } }));
        }
      } finally {
        inFlight.current.delete(id);
      }
    },
    [channel, showNotice, t],
  );

  return { status, run };
}
