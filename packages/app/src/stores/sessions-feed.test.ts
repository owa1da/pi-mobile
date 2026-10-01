import { describe, expect, it, vi } from "vitest";
import type { ChatUpdateEx } from "@/host/chat";
import type { ChatItem, SessionRow, SessionsSnapshot, StartedSession } from "@/host/types";
import { ChatFeed, PENDING_ECHO_TTL_MS } from "./chat-feed";
import { createSessionsRefresher, createSessionsStore, findRow } from "./sessions-store";
import { locateStarted, matchesStarted } from "./start-session";

function row(over: Partial<SessionRow>): SessionRow {
  return {
    key: "s1",
    sessionId: "s1",
    section: "working",
    live: true,
    title: "Fix login",
    cwd: "/home/me/app",
    state: "working",
    since: 0,
    messages: 1,
    ...over,
  };
}

function snapshot(rows: SessionRow[]): SessionsSnapshot {
  return {
    hostName: "box",
    hostNow: 100,
    rows,
    counts: { needs: 0, working: rows.length, completed: 0 },
  };
}

const user = (id: string, text: string): ChatItem => ({
  kind: "user",
  id,
  text,
  images: 0,
  timestamp: 1,
});

function update(items: ChatItem[], over: Partial<ChatUpdateEx> = {}): ChatUpdateEx {
  return {
    cursor: { sessionFile: "/s.jsonl", offset: items.length },
    items,
    reset: false,
    more: false,
    truncated: false,
    ...over,
  };
}

describe("ChatFeed", () => {
  it("reads incrementally with the returned cursor and reports changes", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(update([user("u1", "hi")], { more: true }))
      .mockResolvedValueOnce(update([user("u1", "hi")]));
    const feed = new ChatFeed(read);
    expect(await feed.poll()).toEqual({ changed: true, more: true });
    expect(await feed.poll()).toEqual({ changed: false, more: false });
    expect(read.mock.calls[1]?.[0]).toEqual({ sessionFile: "/s.jsonl", offset: 1 });
  });

  it("keeps an optimistic echo until the transcript shows the prompt", async () => {
    let now = 0;
    const items: ChatItem[] = [user("u1", "again")];
    const read = vi.fn(() => Promise.resolve(update([...items])));
    const feed = new ChatFeed(read, () => now);
    await feed.poll();
    feed.addPending("again");
    await feed.poll();
    expect(feed.pending).toHaveLength(1); // the old identical prompt does not count
    items.push(user("u2", " again "));
    expect((await feed.poll()).changed).toBe(true);
    expect(feed.pending).toHaveLength(0);

    feed.addPending("never shows");
    now += PENDING_ECHO_TTL_MS;
    await feed.poll();
    expect(feed.pending).toHaveLength(0);
  });
});

describe("sessions refresher", () => {
  it("stores snapshots and reports failures to the connection layer", async () => {
    const store = createSessionsStore();
    const reportFailure = vi.fn();
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce(snapshot([row({})]))
      .mockRejectedValueOnce(new Error("gone"));
    const refresh = createSessionsRefresher({
      getService: () => ({ listSessions }),
      reportFailure,
      store,
      now: () => 5,
    });
    expect(await refresh("h1")).toBe(true);
    expect(findRow(store.getState().entries.h1, "s1")?.title).toBe("Fix login");
    expect(await refresh("h1")).toBe(false);
    expect(reportFailure).toHaveBeenCalledWith("h1", expect.any(Error));
    // the last good snapshot stays visible
    expect(store.getState().entries.h1?.snapshot?.rows).toHaveLength(1);
    expect(store.getState().entries.h1?.error).toBe("gone");
  });

  it("does nothing without a connected service", async () => {
    const refresh = createSessionsRefresher({
      getService: () => null,
      reportFailure: vi.fn(),
      store: createSessionsStore(),
    });
    expect(await refresh("h1")).toBe(false);
  });
});

describe("locateStarted", () => {
  const started: StartedSession = { pid: 42, pane: "%7", windowId: "@3", tmuxSession: "main" };

  it("matches the new live row by pid or pane", () => {
    expect(matchesStarted(row({ pid: 42 }), started)).toBe(true);
    expect(matchesStarted(row({ pid: 9, tmux: { socket: "/s", pane: "%7" } }), started)).toBe(true);
    expect(matchesStarted(row({ pid: 42, live: false }), started)).toBe(false);
  });

  it("polls until pi registers, then gives up at the deadline", async () => {
    let now = 0;
    const listSessions = vi
      .fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(snapshot([]))
      .mockResolvedValueOnce(snapshot([row({ sessionId: "new", pid: 42 })]));
    const sleep = (ms: number) => {
      now += ms;
      return Promise.resolve();
    };
    const found = await locateStarted({ listSessions }, started, { sleep, now: () => now });
    expect(found.row?.sessionId).toBe("new");

    const never = vi.fn().mockResolvedValue(snapshot([]));
    const missing = await locateStarted({ listSessions: never }, started, {
      sleep,
      now: () => now,
      timeoutMs: 1000,
      intervalMs: 500,
    });
    expect(missing.row).toBeNull();
    expect(never).toHaveBeenCalledTimes(3);
  });
});
