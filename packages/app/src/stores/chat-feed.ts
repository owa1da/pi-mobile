// Incremental chat state for one session file, plus optimistic echoes of sent prompts.

import { CHAT_CACHE_FILES, type ChatHistoryCursor, type ChatUpdateEx } from "@/host/chat";
import { HostError, type ChatItem, type SessionCursor } from "@/host/types";

export type ChatRead = (cursor?: ChatHistoryCursor) => Promise<ChatUpdateEx>;

export interface PendingEcho {
  id: string;
  text: string;
  sentAt: number;
  /** How many user items with the same text existed when it was sent. */
  baseline: number;
}

export const PENDING_ECHO_TTL_MS = 120_000;

/** Route remounts reuse rows/cursor immediately; the next poll validates the host file. */
export class ChatFeedCache {
  private readonly feeds = new Map<string, ChatFeed>();

  get(hostId: string, file: string, read: ChatRead): ChatFeed {
    const key = JSON.stringify([hostId, file]);
    const feed = this.feeds.get(key) ?? new ChatFeed(read);
    this.feeds.delete(key);
    this.feeds.set(key, feed);
    while (this.feeds.size > CHAT_CACHE_FILES) this.feeds.delete(this.feeds.keys().next().value!);
    return feed;
  }
}

export const chatFeedCache = new ChatFeedCache();

function itemSignature(item: ChatItem): string {
  switch (item.kind) {
    case "tool":
      return `${item.id}:${item.status}:${item.result?.length ?? 0}`;
    case "divider":
      return `${item.id}:${item.label}`;
    default:
      return `${item.id}:${item.text.length}`;
  }
}

export function sameItems(a: readonly ChatItem[], b: readonly ChatItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (itemSignature(a[i]) !== itemSignature(b[i])) return false;
  }
  return true;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function countUser(items: readonly ChatItem[], text: string): number {
  const wanted = normalize(text);
  return items.filter((item) => item.kind === "user" && normalize(item.text) === wanted).length;
}

export class ChatFeed {
  items: ChatItem[] = [];
  cursor: SessionCursor | undefined;
  truncated = false;
  loaded = false;
  hasOlder = false;
  loadingOlder = false;
  private flight: Promise<{ changed: boolean; more: boolean }> | undefined;
  private olderFlight: Promise<void> | undefined;
  pending: PendingEcho[] = [];
  /** Bumped whenever items or pending echoes change. */
  version = 0;
  private nextEcho = 0;

  constructor(
    private readonly read: ChatRead,
    private readonly now: () => number = Date.now,
  ) {}

  /** One read. `more` means more bytes are already waiting: poll again right away. */
  poll(older = false): Promise<{ changed: boolean; more: boolean }> {
    if (this.flight) return this.flight;
    const flight = this.readUpdate(older)
      .catch((error: unknown) => {
        if (
          error instanceof HostError &&
          (error.code === "not-found" ||
            error.message === "Session file changed during ancestor read")
        ) {
          this.items = [];
          this.cursor = undefined;
          this.loaded = false;
          this.hasOlder = false;
          this.truncated = false;
          this.version++;
        }
        throw error;
      })
      .finally(() => {
        if (this.flight === flight) this.flight = undefined;
      });
    this.flight = flight;
    return flight;
  }

  /** Concurrent top-of-list callbacks share one backward window, including during a poll. */
  loadOlder(): Promise<void> {
    if (this.olderFlight) return this.olderFlight;
    if (!this.hasOlder || !this.cursor) return Promise.resolve();
    this.loadingOlder = true;
    this.olderFlight = (async () => {
      if (this.flight) await this.flight;
      if (this.hasOlder) await this.poll(true);
    })().finally(() => {
      this.loadingOlder = false;
      this.olderFlight = undefined;
    });
    return this.olderFlight;
  }

  private async readUpdate(older: boolean): Promise<{ changed: boolean; more: boolean }> {
    const update = await this.read(
      older && this.cursor ? { ...this.cursor, older: true } : this.cursor,
    );
    const changed = !this.loaded || update.reset || !sameItems(this.items, update.items);
    this.cursor = update.cursor;
    this.items = update.items;
    this.truncated = update.truncated;
    this.hasOlder = update.hasOlder ?? update.truncated;
    this.loaded = true;
    const reconciled = this.reconcile();
    if (changed || reconciled) this.version += 1;
    return { changed: changed || reconciled, more: update.more };
  }

  addPending(text: string): PendingEcho {
    this.nextEcho += 1;
    const echo: PendingEcho = {
      id: `pending-${this.nextEcho}`,
      text,
      sentAt: this.now(),
      baseline: countUser(this.items, text),
    };
    this.pending = [...this.pending, echo];
    this.version += 1;
    return echo;
  }

  removePending(id: string): void {
    const next = this.pending.filter((echo) => echo.id !== id);
    if (next.length === this.pending.length) return;
    this.pending = next;
    this.version += 1;
  }

  /** Drops echoes whose prompt now appears in the transcript, or that are too old. */
  reconcile(): boolean {
    const now = this.now();
    const next = this.pending.filter(
      (echo) =>
        now - echo.sentAt < PENDING_ECHO_TTL_MS &&
        countUser(this.items, echo.text) <= echo.baseline,
    );
    if (next.length === this.pending.length) return false;
    this.pending = next;
    return true;
  }
}
