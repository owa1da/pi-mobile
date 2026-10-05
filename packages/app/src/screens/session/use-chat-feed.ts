// Polls readChat for one session while the chat is visible: ~1 s, at once while `more`, faster
// for a few seconds after sending.

import { useCallback, useMemo, useRef, useState } from "react";
import { HostError, type SessionRow } from "@/host/types";
import { connectionStore } from "@/stores/app";
import { ChatFeed, chatFeedCache, type ChatRead } from "@/stores/chat-feed";
import { usePoller } from "@/stores/use-polling";
import { setChatHistory, toChatRows } from "./chat-rows";

const IDLE_MS = 1000;
const BOOST_MS = 300;
const BOOST_FOR_MS = 6000;
const ERROR_MS = 3000;

/** The transcript to follow: the session's own file, or another one (the side, an agent). */
export type FeedSource = Pick<SessionRow, "sessionFile" | "state">;

export function useChatFeed(hostId: string, row: FeedSource | undefined, active: boolean) {
  const sessionFile = row?.sessionFile;
  const [version, setVersion] = useState(0);
  /**
   * pi writes a new session's file only with its first entry: until then the file is not there.
   * That is an empty chat (just the composer), not a read that is still pending.
   */
  const [missing, setMissing] = useState(false);
  const boostUntil = useRef(0);
  const feed = useMemo(() => {
    const read: ChatRead = (cursor) => {
      const service = connectionStore.getState().getService(hostId);
      if (!service || !sessionFile) return Promise.reject(new Error("not connected"));
      return service.readChat({ sessionFile }, cursor);
    };
    return sessionFile ? chatFeedCache.get(hostId, sessionFile, read) : new ChatFeed(read);
  }, [hostId, sessionFile]);

  const run = useCallback(async () => {
    if (!connectionStore.getState().getService(hostId)) return ERROR_MS;
    try {
      const { changed, more } = await feed.poll();
      setMissing(false);
      if (changed) setVersion(feed.version);
      if (more) return 0;
    } catch (error) {
      setVersion(feed.version);
      if (error instanceof HostError && error.code === "not-found") {
        setMissing(true);
        return IDLE_MS;
      }
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

  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlder = useCallback(() => {
    if (!active || !feed.hasOlder || feed.loadingOlder) return;
    const request = feed.loadOlder();
    setLoadingOlder(true);
    void request
      .catch((error: unknown) => {
        connectionStore.getState().reportFailure(hostId, error);
      })
      .finally(() => {
        setLoadingOlder(false);
        setVersion(feed.version);
      });
  }, [active, feed, hostId]);

  const working = row?.state === "working";
  const rows = useMemo(
    () => {
      const next = toChatRows(feed.items, feed.pending, working);
      return feed.hasOlder || loadingOlder
        ? setChatHistory(next, { loadOlder, loading: loadingOlder })
        : next;
    },
    // version is the change signal for the feed's mutable arrays
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed, version, working, loadingOlder, loadOlder],
  );

  return {
    rows,
    truncated: feed.truncated,
    // The spinner shows only while the first read is pending: never for a file not written yet.
    loading: Boolean(sessionFile) && !feed.loaded && !missing,
    hasFile: Boolean(sessionFile),
    boost,
    addPending,
    removePending,
  };
}
