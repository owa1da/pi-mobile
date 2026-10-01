// Polls readChat for one session while the chat is visible: ~1 s, at once while `more`, faster
// for a few seconds after sending.

import { useCallback, useMemo, useRef, useState } from "react";
import type { SessionRow } from "@/host/types";
import { connectionStore } from "@/stores/app";
import { ChatFeed } from "@/stores/chat-feed";
import { usePoller } from "@/stores/use-polling";
import { toChatRows } from "./chat-rows";

const IDLE_MS = 1000;
const BOOST_MS = 300;
const BOOST_FOR_MS = 6000;
const ERROR_MS = 3000;

export function useChatFeed(hostId: string, row: SessionRow | undefined, active: boolean) {
  const sessionFile = row?.sessionFile;
  const [version, setVersion] = useState(0);
  const boostUntil = useRef(0);
  const feed = useMemo(
    () =>
      new ChatFeed((cursor) => {
        const service = connectionStore.getState().getService(hostId);
        if (!service || !sessionFile) return Promise.reject(new Error("not connected"));
        return service.readChat({ sessionFile }, cursor);
      }),
    [hostId, sessionFile],
  );

  const run = useCallback(async () => {
    if (!connectionStore.getState().getService(hostId)) return ERROR_MS;
    try {
      const { changed, more } = await feed.poll();
      if (changed) setVersion(feed.version);
      if (more) return 0;
    } catch (error) {
      connectionStore.getState().reportFailure(hostId, error);
      return ERROR_MS;
    }
    return Date.now() < boostUntil.current ? BOOST_MS : IDLE_MS;
  }, [feed, hostId]);

  const kick = usePoller(run, IDLE_MS, active && Boolean(sessionFile));

  const boost = useCallback(() => {
    boostUntil.current = Date.now() + BOOST_FOR_MS;
    kick();
  }, [kick]);

  const addPending = useCallback(
    (text: string) => {
      const echo = feed.addPending(text);
      setVersion(feed.version);
      return echo.id;
    },
    [feed],
  );

  const removePending = useCallback(
    (id: string) => {
      feed.removePending(id);
      setVersion(feed.version);
    },
    [feed],
  );

  const working = row?.state === "working";
  const rows = useMemo(
    () => toChatRows(feed.items, feed.pending, working),
    // version is the change signal for the feed's mutable arrays
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed, version, working],
  );

  return {
    rows,
    truncated: feed.truncated,
    loading: Boolean(sessionFile) && !feed.loaded,
    hasFile: Boolean(sessionFile),
    boost,
    addPending,
    removePending,
  };
}
