import { describe, expect, it, vi } from "vitest";
import { createNotificationNavigation, notificationBehavior } from "./navigation";
const data = { hostId: "h", sessionId: "s", eventId: "e", kind: "finished" };

describe("notification routing and presentation", () => {
  it("suppresses only the same foreground session and ignores deleted hosts", () => {
    expect(
      notificationBehavior(data, true, { kind: "session", hostId: "h", sessionId: "s" }, true)
        .shouldShowBanner,
    ).toBe(false);
    expect(
      notificationBehavior(data, true, { kind: "session", hostId: "h", sessionId: "other" }, true)
        .shouldShowBanner,
    ).toBe(true);
    expect(
      notificationBehavior(data, false, { kind: "session", hostId: "h", sessionId: "s" }, true)
        .shouldShowBanner,
    ).toBe(true);
    expect(notificationBehavior(data, true, { kind: "hosts" }, false).shouldShowBanner).toBe(false);
  });
  it("queues cold and warm taps until hosts and navigation are ready; dedupes eventId", () => {
    const push = vi.fn();
    const nav = createNotificationNavigation(() => true, push);
    nav.receive(data);
    nav.flush(false, true);
    nav.flush(true, false);
    expect(push).not.toHaveBeenCalled();
    expect(nav.canRestore()).toBe(false);
    nav.flush(true, true);
    expect(push).toHaveBeenCalledWith({
      pathname: "/h/[hostId]/s/[sessionId]",
      params: { hostId: "h", sessionId: "s" },
    });
    nav.receive(data);
    nav.flush(true, true);
    expect(push).toHaveBeenCalledTimes(1);
    nav.receive({ ...data, eventId: "warm" });
    nav.flush(true, true);
    expect(push).toHaveBeenCalledTimes(2);
    expect(nav.canRestore()).toBe(false);
  });
  it("persists only the last 50 consumed event ids before routing and ignores them on reload", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const push = vi.fn(() => {
      expect([...values.values()]).toHaveLength(1);
    });
    const nav = createNotificationNavigation(() => true, push, storage);
    await nav.load();
    for (let i = 0; i < 55; i++) {
      nav.receive({ ...data, eventId: `event-${i}` });
      await nav.flush(true, true);
    }
    expect(JSON.parse([...values.values()][0]!)).toEqual(
      Array.from({ length: 50 }, (_, i) => `event-${i + 5}`),
    );
    const reloaded = createNotificationNavigation(() => true, push, storage);
    // A response arriving before history loads must also be filtered.
    reloaded.receive({ ...data, eventId: "event-54" });
    await reloaded.flush(true, true);
    expect(push).toHaveBeenCalledTimes(55);
    expect(reloaded.canRestore()).toBe(true);
  });
  it("still routes once when consumed history cannot be persisted", async () => {
    const push = vi.fn();
    const nav = createNotificationNavigation(() => true, push, {
      getItem: async () => null,
      setItem: async () => {
        throw new Error("storage unavailable");
      },
    });
    nav.receive(data);
    await nav.flush(true, true);
    expect(push).toHaveBeenCalledTimes(1);
    nav.receive(data);
    await nav.flush(true, true);
    expect(push).toHaveBeenCalledTimes(1);
  });
  it("starts with empty history when it cannot be read", async () => {
    const push = vi.fn();
    let reads = 0;
    const nav = createNotificationNavigation(() => true, push, {
      getItem: async () => {
        reads++;
        throw new Error("storage unavailable");
      },
      setItem: async () => {},
    });
    await expect(nav.load()).resolves.toBeUndefined();
    nav.receive(data);
    await nav.flush(true, true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(reads).toBe(1);
  });
  it("unknown hosts and invalid data do not route or defeat restoration", () => {
    const push = vi.fn();
    const nav = createNotificationNavigation(() => false, push);
    nav.receive(data);
    nav.receive({ ...data, eventId: null });
    nav.flush(true, true);
    expect(push).not.toHaveBeenCalled();
    expect(nav.canRestore()).toBe(true);
  });
});
