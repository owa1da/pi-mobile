// Keep the user's place across the reload that follows a system font-size change: the route
// (hosts → dashboard → session) and the session's Chat/Terminal tab. Only ids and the tab are
// stored (no secrets, no host details); the record is read once at startup and then deleted.

import type { SavedHost } from "@/host/types";

export type SessionTab = "chat" | "terminal";

export type Place =
  | { kind: "hosts" }
  | { kind: "dashboard"; hostId: string }
  | { kind: "session"; hostId: string; sessionId: string; tab: SessionTab };

export interface SavedPlace {
  v: 1;
  savedAt: number;
  place: Place;
}

export type RestoreStep =
  | { pathname: "/h/[hostId]"; params: { hostId: string } }
  | {
      pathname: "/h/[hostId]/s/[sessionId]";
      params: { hostId: string; sessionId: string; tab: SessionTab; restored: "1" };
    };

export interface PlaceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const PLACE_STORAGE_KEY = "pi.restorePlace.v1";
/** A record older than this is from an interrupted reload, not the one that just happened. */
export const PLACE_MAX_AGE_MS = 2 * 60_000;

let current: Place = { kind: "hosts" };

/** The focused screen reports where the user is; the last report wins. */
export function reportPlace(place: Place): void {
  current = place;
}

export function currentPlace(): Place {
  return current;
}

export function serializePlace(place: Place, now: number): string {
  const saved: SavedPlace = { v: 1, savedAt: now, place };
  return JSON.stringify(saved);
}

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function parsePlaceBody(value: unknown): Place | null {
  if (!value || typeof value !== "object") return null;
  const place = value as Record<string, unknown>;
  if (place.kind === "hosts") return { kind: "hosts" };
  if (!isId(place.hostId)) return null;
  if (place.kind === "dashboard") return { kind: "dashboard", hostId: place.hostId };
  if (place.kind !== "session" || !isId(place.sessionId)) return null;
  const tab: SessionTab = place.tab === "terminal" ? "terminal" : "chat";
  return { kind: "session", hostId: place.hostId, sessionId: place.sessionId, tab };
}

/** A saved place, or null when the record is missing, malformed, from another version or stale. */
export function parseSavedPlace(raw: string | null, now: number): Place | null {
  if (!raw) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!saved || typeof saved !== "object") return null;
  const record = saved as Record<string, unknown>;
  if (record.v !== 1 || typeof record.savedAt !== "number") return null;
  const age = now - record.savedAt;
  if (age < 0 || age > PLACE_MAX_AGE_MS) return null;
  return parsePlaceBody(record.place);
}

/**
 * The pushes that rebuild the stack above Hosts. Nothing when the host is gone, or when it was
 * never trusted (restoring would raise a trust prompt the user did not ask for).
 */
export function restoreSteps(
  place: Place | null,
  getHost: (hostId: string) => SavedHost | undefined,
): RestoreStep[] {
  if (!place || place.kind === "hosts") return [];
  const host = getHost(place.hostId);
  if (!host?.hostKeyFingerprint) return [];
  const dashboard: RestoreStep = { pathname: "/h/[hostId]", params: { hostId: host.id } };
  if (place.kind === "dashboard") return [dashboard];
  return [
    dashboard,
    {
      pathname: "/h/[hostId]/s/[sessionId]",
      params: { hostId: host.id, sessionId: place.sessionId, tab: place.tab, restored: "1" },
    },
  ];
}

export type RestoredSessionOutcome = "show" | "wait" | "leave";

/**
 * A restored session screen, decided once: show it when its row is in the host's snapshot, leave
 * for the dashboard when the snapshot arrived without it (the session is gone), wait otherwise.
 */
export function restoredSessionOutcome(
  hasRow: boolean,
  hasSnapshot: boolean,
): RestoredSessionOutcome {
  if (hasRow) return "show";
  return hasSnapshot ? "leave" : "wait";
}

/** Persist where the user is, before the app reloads. */
export async function savePlace(storage: PlaceStorage, place: Place, now: number): Promise<void> {
  if (place.kind === "hosts") {
    await storage.removeItem(PLACE_STORAGE_KEY);
    return;
  }
  await storage.setItem(PLACE_STORAGE_KEY, serializePlace(place, now));
}

/** Read the saved place once and delete it, whatever it held. */
export async function takeSavedPlace(storage: PlaceStorage, now: number): Promise<Place | null> {
  let raw: string | null = null;
  try {
    raw = await storage.getItem(PLACE_STORAGE_KEY);
  } finally {
    await storage.removeItem(PLACE_STORAGE_KEY).catch(() => undefined);
  }
  return parseSavedPlace(raw, now);
}
