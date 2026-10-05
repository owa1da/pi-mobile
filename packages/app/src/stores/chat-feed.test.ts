import { describe, expect, it, vi } from "vitest";
import { ChatReader, type ChatUpdateEx } from "@/host/chat";
import { HostError } from "@/host/types";
import { ChatFeed, ChatFeedCache } from "./chat-feed";

const update = (ids: string[], hasOlder = true): ChatUpdateEx => ({
  cursor: { sessionFile: "/session", offset: 100 },
  items: ids.map((id) => ({ kind: "user", id, text: id, images: 0, timestamp: 0 })),
  more: false,
  reset: false,
  truncated: hasOlder,
  hasOlder,
});

describe("chat pagination and remount cache", () => {
  it("deduplicates older requests and merges chronological host items", async () => {
    let resolve!: (value: ChatUpdateEx) => void;
    const read = vi
      .fn()
      .mockResolvedValueOnce(update(["new"]))
      .mockImplementationOnce(
        () =>
          new Promise<ChatUpdateEx>((done) => {
            resolve = done;
          }),
      );
    const feed = new ChatFeed(read);
    await feed.poll();
    const a = feed.loadOlder();
    const b = feed.loadOlder();
    expect(a).toBe(b);
    expect(feed.loadingOlder).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][0]).toEqual({ sessionFile: "/session", offset: 100, older: true });
    resolve(update(["old", "new"], false));
    await a;
    expect(feed.loadingOlder).toBe(false);
    expect(feed.items.map((item) => item.id)).toEqual(["old", "new"]);
    expect(feed.truncated).toBe(false);
    await feed.loadOlder();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("queues one older window behind an in-flight poll", async () => {
    let resolve!: (value: ChatUpdateEx) => void;
    const read = vi
      .fn()
      .mockResolvedValueOnce(update(["new"]))
      .mockImplementationOnce(
        () =>
          new Promise<ChatUpdateEx>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce(update(["old", "new"]));
    const feed = new ChatFeed(read);
    await feed.poll();
    const poll = feed.poll();
    const older = feed.loadOlder();
    expect(feed.loadOlder()).toBe(older);
    expect(read).toHaveBeenCalledTimes(2);
    resolve(update(["new"]));
    await poll;
    await older;
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[2][0].older).toBe(true);
  });

  it("reuses cached rows instantly and validates with one incremental read", async () => {
    const cache = new ChatFeedCache();
    const run = vi.fn(async (script: string) => {
      const nonce = /N='([^']+)'/.exec(script)?.[1];
      if (!nonce) throw new Error("missing nonce");
      const line =
        JSON.stringify({
          type: "message",
          id: "u",
          parentId: null,
          message: { role: "user", content: "hi" },
        }) + "\n";
      return script.includes("; O=0;")
        ? `${nonce} D fresh ${Buffer.byteLength(line)} 7 0\n${Buffer.from(line).toString("base64")}\n${nonce} Z\n`
        : `${nonce} D inc ${Buffer.byteLength(line)} 7 ${Buffer.byteLength(line) - 1}\nCg==\n${nonce} Z\n`;
    });
    const reader = new ChatReader(run);
    const read = vi.fn((cursor) => reader.read("/session", cursor));
    const first = cache.get("h", "/session", read);
    await first.poll();
    const rows = first.items;
    const reopened = cache.get("h", "/session", read);
    expect(reopened).toBe(first);
    expect(reopened.items).toBe(rows);
    expect(reopened.loaded).toBe(true);
    run.mockClear();
    await reopened.poll();
    expect(run).toHaveBeenCalledTimes(1);
    expect(reopened.items).toBe(rows); // built document is reused on unchanged validation
  });

  it("isolates hosts and evicts the least recently used of eight files", () => {
    const cache = new ChatFeedCache();
    const read = vi.fn();
    const first = cache.get("a", "/0", read);
    const otherHost = cache.get("b", "/0", read);
    expect(otherHost).not.toBe(first);
    for (let i = 1; i < 7; i++) cache.get("a", `/${i}`, read);
    expect(cache.get("a", "/0", read)).toBe(first);
    cache.get("a", "/7", read);
    expect(cache.get("a", "/0", read)).toBe(first);
    expect(cache.get("b", "/0", read)).not.toBe(otherHost);
  });

  it("replaces cached rows on reset and clears missing or invalidated files", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(update(["old"]))
      .mockResolvedValueOnce({ ...update(["replacement"], false), reset: true })
      .mockRejectedValueOnce(new HostError("not-found", "gone"));
    const feed = new ChatFeed(read);
    await feed.poll();
    await feed.poll();
    expect(feed.items.map((item) => item.id)).toEqual(["replacement"]);
    await expect(feed.poll()).rejects.toMatchObject({ code: "not-found" });
    expect(feed.items).toEqual([]);
    expect(feed.cursor).toBeUndefined();
  });
});
