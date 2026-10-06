import { describe, expect, it, vi } from "vitest";
import { ChatReader, type ChatUpdateEx } from "@/host/chat";
import { HostError, type ChatItem } from "@/host/types";
import { ChatFeed, ChatFeedCache, sameItems } from "./chat-feed";

const update = (ids: string[], hasOlder = true): ChatUpdateEx => ({
  cursor: { sessionFile: "/session", offset: 100 },
  items: ids.map((id) => ({ kind: "user", id, text: id, images: 0, timestamp: 0 })),
  more: false,
  reset: false,
  truncated: hasOlder,
  hasOlder,
});

describe("chat feed render equality", () => {
  const assistant: ChatItem = { kind: "assistant", id: "a", text: "left", timestamp: 0 };
  const user: ChatItem = { kind: "user", id: "u", text: "left", images: 0, timestamp: 0 };
  const tool: ChatItem = {
    kind: "tool",
    id: "t",
    name: "read",
    args: { path: "/old", options: { limit: 1 } },
    status: "completed",
    result: "left",
    timestamp: 0,
  };
  const notice: ChatItem = {
    kind: "notice",
    id: "n",
    text: "left",
    level: "info",
    timestamp: 0,
  };
  const divider: ChatItem = { kind: "divider", id: "d", label: "Branch", timestamp: 0 };

  it.each<{ label: string; before: ChatItem; after: ChatItem }>([
    { label: "assistant text", before: assistant, after: { ...assistant, text: "wide" } },
    { label: "user text", before: user, after: { ...user, text: "wide" } },
    {
      label: "thinking text",
      before: { ...assistant, kind: "thinking" },
      after: { ...assistant, kind: "thinking", text: "wide" },
    },
    { label: "notice text", before: notice, after: { ...notice, text: "wide" } },
    { label: "tool result", before: tool, after: { ...tool, result: "wide" } },
    { label: "tool name", before: tool, after: { ...tool, name: "write" } },
    { label: "tool arguments", before: tool, after: { ...tool, args: { path: "/new" } } },
    {
      label: "nested tool arguments",
      before: tool,
      after: { ...tool, args: { path: "/old", options: { limit: 2 } } },
    },
    { label: "tool error", before: tool, after: { ...tool, isError: true } },
    { label: "tool status", before: tool, after: { ...tool, status: "running" } },
    { label: "notice level", before: notice, after: { ...notice, level: "warning" } },
    { label: "divider summary", before: divider, after: { ...divider, summary: "Summary" } },
    { label: "divider label", before: divider, after: { ...divider, label: "Switch" } },
    { label: "user images", before: user, after: { ...user, images: 1 } },
    { label: "timestamp", before: assistant, after: { ...assistant, timestamp: 1 } },
    { label: "kind", before: assistant, after: { ...assistant, kind: "thinking" } },
    { label: "id", before: assistant, after: { ...assistant, id: "b" } },
  ])("detects changes to $label", ({ before, after }) => {
    expect(sameItems([before], [after])).toBe(false);
  });

  it("keeps equal reconstructed items unchanged", () => {
    const items = [assistant, user, tool, notice, divider];
    expect(sameItems(items, JSON.parse(JSON.stringify(items)))).toBe(true);
    expect(sameItems(items, items)).toBe(true);
    expect(sameItems(items, items.slice(1))).toBe(false);
    expect(sameItems(items, items.toReversed())).toBe(false);
  });

  it("bumps the row change signal for a same-length replacement without a reset", async () => {
    const first = { ...update([], false), items: [assistant] };
    const replacement = { ...assistant, text: "wide" };
    const read = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ ...first, items: [replacement] })
      .mockResolvedValueOnce({ ...first, items: [{ ...replacement }] });
    const feed = new ChatFeed(read);
    await feed.poll();
    const version = feed.version;
    expect(await feed.poll()).toEqual({ changed: true, more: false });
    expect(feed.version).toBe(version + 1);
    expect(feed.items).toEqual([replacement]);
    expect(await feed.poll()).toEqual({ changed: false, more: false });
    expect(feed.version).toBe(version + 1);
  });
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
