import type { Place } from "@/navigation/restore-place";
export interface PushData {
  hostId: string;
  sessionId: string;
  eventId: string;
  kind: string;
}
export interface PushRoute {
  pathname: "/h/[hostId]/s/[sessionId]";
  params: { hostId: string; sessionId: string };
}
export function parsePushData(value: unknown): PushData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  for (const key of ["hostId", "sessionId", "eventId", "kind"]) {
    if (
      typeof data[key] !== "string" ||
      !data[key].length ||
      data[key].length > 1024 ||
      Array.from(data[key]).some((character) => character.charCodeAt(0) < 32)
    )
      return null;
  }
  return {
    hostId: data.hostId as string,
    sessionId: data.sessionId as string,
    eventId: data.eventId as string,
    kind: data.kind as string,
  };
}
export function notificationBehavior(
  value: unknown,
  active: boolean,
  place: Place,
  hostExists: boolean,
) {
  const data = parsePushData(value);
  const sameSession =
    data &&
    active &&
    place.kind === "session" &&
    place.hostId === data.hostId &&
    place.sessionId === data.sessionId;
  const show = Boolean(data && hostExists && !sameSession);
  return {
    shouldShowBanner: show,
    shouldShowList: show,
    shouldPlaySound: show,
    shouldSetBadge: false,
  };
}

const CONSUMED_KEY = "pi.notifications.consumed.v1";
const CONSUMED_LIMIT = 50;
interface NavigationStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Only navigation. It never connects, sends input or resumes a session. */
export function createNotificationNavigation(
  hostExists: (id: string) => boolean,
  push: (route: PushRoute) => void,
  storage?: NavigationStorage,
) {
  const seen = new Set<string>();
  let consumed: string[] = [];
  let pending: PushData[] = [];
  let claimed = false;
  let loading: Promise<void> | undefined;
  let flushing = Promise.resolve();
  const load = () =>
    (loading ??= (async () => {
      if (!storage) return;
      // Unreadable history must not stop listeners or taps: start empty, dedupe in memory.
      const raw = await storage.getItem(CONSUMED_KEY).catch(() => null);
      try {
        const saved: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(saved)) {
          consumed = [
            ...new Set(
              saved.filter(
                (id): id is string =>
                  typeof id === "string" &&
                  id.length > 0 &&
                  id.length <= 1024 &&
                  !Array.from(id).some((character) => character.charCodeAt(0) < 32),
              ),
            ),
          ].slice(-CONSUMED_LIMIT);
        }
      } catch {
        // Ignore malformed non-secret history.
      }
      for (const id of consumed) seen.add(id);
      pending = pending.filter((data) => !consumed.includes(data.eventId));
    })());
  const navigate = (data: PushData) => {
    claimed = true;
    push({
      pathname: "/h/[hostId]/s/[sessionId]",
      params: { hostId: data.hostId, sessionId: data.sessionId },
    });
  };
  return {
    load,
    receive(value: unknown) {
      const data = parsePushData(value);
      if (!data || seen.has(data.eventId)) return;
      seen.add(data.eventId);
      pending.push(data);
    },
    canRestore: () => !claimed && !pending.some((data) => hostExists(data.hostId)),
    flush(hostsLoaded: boolean, navigationReady: boolean) {
      if (!hostsLoaded || !navigationReady) return;
      if (!storage) {
        const taps = pending;
        pending = [];
        for (const data of taps) if (hostExists(data.hostId)) navigate(data);
        return;
      }
      const task = flushing
        .catch(() => undefined)
        .then(async () => {
          await load();
          const taps = pending;
          pending = [];
          for (const data of taps) {
            if (!hostExists(data.hostId) || consumed.includes(data.eventId)) continue;
            claimed = true;
            consumed = [...consumed, data.eventId].slice(-CONSUMED_LIMIT);
            // Commit before routing so a JS reload cannot replay Expo's retained response.
            // History contains only event ids, never push tokens or notification contents.
            // A failed write still routes once; in-memory dedupe covers this run.
            await storage.setItem(CONSUMED_KEY, JSON.stringify(consumed)).catch(() => undefined);
            if (hostExists(data.hostId)) navigate(data);
          }
          return undefined;
        });
      flushing = task;
      return task;
    },
  };
}
