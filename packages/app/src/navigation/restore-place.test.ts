import { beforeEach, describe, expect, it } from "vitest";
import type { SavedHost } from "@/host/types";
import {
  PLACE_MAX_AGE_MS,
  PLACE_STORAGE_KEY,
  currentPlace,
  parseSavedPlace,
  reportPlace,
  restoreSteps,
  restoredSessionOutcome,
  savePlace,
  serializePlace,
  takeSavedPlace,
  type Place,
} from "./restore-place";

function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => Promise.resolve(entries.get(key) ?? null),
    setItem: (key: string, value: string) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key: string) => {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}

const NOW = 1_000_000;
const pinned: SavedHost = {
  id: "h1",
  label: "Desk",
  host: "10.0.0.2",
  port: 22,
  username: "me",
  authType: "key",
  secretRef: "h1",
  hostKeyFingerprint: "SHA256:abc",
  createdAt: 1,
};
const unpinned: SavedHost = { ...pinned, id: "h2", hostKeyFingerprint: undefined };
const hosts = new Map([
  [pinned.id, pinned],
  [unpinned.id, unpinned],
]);
const getHost = (id: string) => hosts.get(id);

const session: Place = { kind: "session", hostId: "h1", sessionId: "s1", tab: "terminal" };

describe("restore place", () => {
  beforeEach(() => reportPlace({ kind: "hosts" }));

  it("tracks the last reported place", () => {
    expect(currentPlace()).toEqual({ kind: "hosts" });
    reportPlace({ kind: "dashboard", hostId: "h1" });
    reportPlace(session);
    expect(currentPlace()).toEqual(session);
  });

  it("round-trips dashboard and session places, ids and tab only", () => {
    const raw = serializePlace(session, NOW);
    expect(JSON.parse(raw)).toEqual({ v: 1, savedAt: NOW, place: session });
    expect(parseSavedPlace(raw, NOW + 1000)).toEqual(session);
    const dashboard: Place = { kind: "dashboard", hostId: "h1" };
    expect(parseSavedPlace(serializePlace(dashboard, NOW), NOW)).toEqual(dashboard);
  });

  it("rejects stale, future, malformed and foreign records", () => {
    const raw = serializePlace(session, NOW);
    expect(parseSavedPlace(raw, NOW + PLACE_MAX_AGE_MS + 1)).toBeNull();
    expect(parseSavedPlace(raw, NOW - 1)).toBeNull();
    expect(parseSavedPlace(null, NOW)).toBeNull();
    expect(parseSavedPlace("{not json", NOW)).toBeNull();
    expect(parseSavedPlace("42", NOW)).toBeNull();
    expect(parseSavedPlace(JSON.stringify({ v: 2, savedAt: NOW, place: session }), NOW)).toBeNull();
    const noSession = { v: 1, savedAt: NOW, place: { kind: "session", hostId: "h1" } };
    expect(parseSavedPlace(JSON.stringify(noSession), NOW)).toBeNull();
    const noHost = { v: 1, savedAt: NOW, place: { kind: "dashboard", hostId: "" } };
    expect(parseSavedPlace(JSON.stringify(noHost), NOW)).toBeNull();
  });

  it("falls back to the Chat tab for an unknown tab", () => {
    const odd = { v: 1, savedAt: NOW, place: { ...session, tab: "logs" } };
    expect(parseSavedPlace(JSON.stringify(odd), NOW)).toEqual({ ...session, tab: "chat" });
  });

  it("rebuilds dashboard then session, carrying the tab", () => {
    expect(restoreSteps(session, getHost)).toEqual([
      { pathname: "/h/[hostId]", params: { hostId: "h1" } },
      {
        pathname: "/h/[hostId]/s/[sessionId]",
        params: { hostId: "h1", sessionId: "s1", tab: "terminal", restored: "1" },
      },
    ]);
    expect(restoreSteps({ kind: "dashboard", hostId: "h1" }, getHost)).toEqual([
      { pathname: "/h/[hostId]", params: { hostId: "h1" } },
    ]);
  });

  it("restores nothing for Hosts, a deleted host or a host that was never trusted", () => {
    expect(restoreSteps(null, getHost)).toEqual([]);
    expect(restoreSteps({ kind: "hosts" }, getHost)).toEqual([]);
    expect(restoreSteps({ ...session, hostId: "gone" }, getHost)).toEqual([]);
    expect(restoreSteps({ kind: "dashboard", hostId: "h2" }, getHost)).toEqual([]);
  });

  it("decides a restored session once its host's snapshot is known", () => {
    expect(restoredSessionOutcome(true, true)).toBe("show");
    expect(restoredSessionOutcome(true, false)).toBe("show");
    expect(restoredSessionOutcome(false, false)).toBe("wait");
    expect(restoredSessionOutcome(false, true)).toBe("leave");
  });

  it("saves before the reload and takes the record exactly once", async () => {
    const storage = memoryStorage();
    await savePlace(storage, session, NOW);
    expect(storage.entries.has(PLACE_STORAGE_KEY)).toBe(true);
    expect(await takeSavedPlace(storage, NOW + 500)).toEqual(session);
    expect(storage.entries.has(PLACE_STORAGE_KEY)).toBe(false);
    expect(await takeSavedPlace(storage, NOW + 600)).toBeNull();
  });

  it("clears a stale record and an earlier place when the user is on Hosts", async () => {
    const storage = memoryStorage();
    await savePlace(storage, session, NOW);
    expect(await takeSavedPlace(storage, NOW + PLACE_MAX_AGE_MS + 1)).toBeNull();
    expect(storage.entries.size).toBe(0);
    await savePlace(storage, session, NOW);
    await savePlace(storage, { kind: "hosts" }, NOW);
    expect(storage.entries.size).toBe(0);
  });

  it("still clears the record when reading it fails", async () => {
    const storage = memoryStorage();
    await savePlace(storage, session, NOW);
    const failing = { ...storage, getItem: () => Promise.reject(new Error("io")) };
    await expect(takeSavedPlace(failing, NOW)).rejects.toThrow("io");
    expect(storage.entries.size).toBe(0);
  });
});
