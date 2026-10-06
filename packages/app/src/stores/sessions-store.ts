// Latest session snapshot per host, shared by the dashboard and the session screen.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { SessionRow, SessionsSnapshot } from "@/host/types";

export interface SessionsEntry {
  snapshot?: SessionsSnapshot;
  /** Phone clock (ms) when the snapshot arrived. */
  fetchedAt?: number;
  error?: string;
  /** Successful, applied listing generation (not a render or a failed request). */
  generation?: number;
  /** Successful listings only, so watchers can count misses after presence is pruned. */
  listingCount?: number;
  presence?: Record<string, SessionPresence>;
}

export interface SessionsState {
  entries: Record<string, SessionsEntry>;
  beginListing(hostId: string): number;
  setSnapshot(hostId: string, snapshot: SessionsSnapshot, at: number, generation?: number): boolean;
  setError(hostId: string, message: string, generation?: number): boolean;
  clear(hostId: string): void;
}

export type SessionsStore = StoreApi<SessionsState>;

export function createSessionsStore(): SessionsStore {
  let nextGeneration = 0;
  const applied = new Map<string, number>();
  return createStore<SessionsState>()((set) => ({
    entries: {},
    beginListing: () => ++nextGeneration,
    setSnapshot: (hostId, snapshot, at, generation = ++nextGeneration) => {
      if (generation <= (applied.get(hostId) ?? 0)) return false;
      applied.set(hostId, generation);
      set((state) => {
        const listingCount = (state.entries[hostId]?.listingCount ?? 0) + 1;
        const presence: Record<string, SessionPresence> = {};
        for (const row of snapshot.rows)
          presence[row.sessionId] = { generation, listingCount, row, misses: 0 };
        for (const [id, previous] of Object.entries(state.entries[hostId]?.presence ?? {})) {
          const misses = previous.misses + 1;
          // Current rows were already added; absent rows only survive the settling window.
          if (!presence[id] && misses < 3)
            presence[id] = { ...previous, generation, listingCount, misses };
        }
        return {
          entries: {
            ...state.entries,
            [hostId]: { snapshot, fetchedAt: at, generation, listingCount, presence },
          },
        };
      });
      return true;
    },
    setError: (hostId, message, generation = ++nextGeneration) => {
      if (generation <= (applied.get(hostId) ?? 0)) return false;
      applied.set(hostId, generation);
      set((state) => ({
        entries: { ...state.entries, [hostId]: { ...state.entries[hostId], error: message } },
      }));
      return true;
    },
    clear: (hostId) =>
      set((state) => {
        const entries = { ...state.entries };
        delete entries[hostId];
        applied.set(hostId, ++nextGeneration);
        return { entries };
      }),
  }));
}

export function findRow(
  entry: SessionsEntry | undefined,
  sessionId: string,
): SessionRow | undefined {
  return entry?.snapshot?.rows.find((row) => row.sessionId === sessionId);
}

export interface SessionPresence {
  generation?: number;
  listingCount?: number;
  row?: SessionRow;
  misses: number;
}

/** Retained rows are display-only; findRow always reads the actual listing. */
export function settleSessionPresence(
  previous: SessionPresence,
  entry: SessionsEntry | undefined,
  sessionId: string,
): SessionPresence {
  if (!entry?.snapshot || entry.generation === previous.generation) return previous;
  const known = entry.presence?.[sessionId];
  if (known) return known;
  const row = findRow(entry, sessionId);
  const elapsed =
    entry.listingCount === undefined
      ? 1
      : Math.max(1, entry.listingCount - (previous.listingCount ?? 0));
  return {
    generation: entry.generation,
    listingCount: entry.listingCount,
    row: row ?? previous.row,
    misses: row ? 0 : previous.misses + elapsed,
  };
}

export function sessionIsGone(presence: SessionPresence, pending: boolean): boolean {
  return presence.misses >= 3 && !pending;
}

export interface ListingService {
  listSessions(): Promise<SessionsSnapshot>;
}

export interface SessionsRefresherDeps {
  getService: (hostId: string) => ListingService | null;
  reportFailure: (hostId: string, error: unknown) => void;
  store: SessionsStore;
  now?: () => number;
}

/** One listing for a host into the store. Resolves false when there is no service or it failed. */
export function createSessionsRefresher(deps: SessionsRefresherDeps) {
  const now = deps.now ?? Date.now;
  return async function refresh(hostId: string): Promise<boolean> {
    const service = deps.getService(hostId);
    if (!service) return false;
    const generation = deps.store.getState().beginListing(hostId);
    try {
      const snapshot = await service.listSessions();
      return deps.store.getState().setSnapshot(hostId, snapshot, now(), generation);
    } catch (error) {
      const fresh = deps.store
        .getState()
        .setError(hostId, error instanceof Error ? error.message : String(error), generation);
      if (fresh) deps.reportFailure(hostId, error);
      return false;
    }
  };
}
