// Latest session snapshot per host, shared by the dashboard and the session screen.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { SessionRow, SessionsSnapshot } from "@/host/types";

export interface SessionsEntry {
  snapshot?: SessionsSnapshot;
  /** Phone clock (ms) when the snapshot arrived. */
  fetchedAt?: number;
  error?: string;
}

export interface SessionsState {
  entries: Record<string, SessionsEntry>;
  setSnapshot(hostId: string, snapshot: SessionsSnapshot, at: number): void;
  setError(hostId: string, message: string): void;
  clear(hostId: string): void;
}

export type SessionsStore = StoreApi<SessionsState>;

export function createSessionsStore(): SessionsStore {
  return createStore<SessionsState>()((set) => ({
    entries: {},
    setSnapshot: (hostId, snapshot, at) =>
      set((state) => ({ entries: { ...state.entries, [hostId]: { snapshot, fetchedAt: at } } })),
    setError: (hostId, message) =>
      set((state) => ({
        entries: { ...state.entries, [hostId]: { ...state.entries[hostId], error: message } },
      })),
    clear: (hostId) =>
      set((state) => {
        const entries = { ...state.entries };
        delete entries[hostId];
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
    try {
      const snapshot = await service.listSessions();
      deps.store.getState().setSnapshot(hostId, snapshot, now());
      return true;
    } catch (error) {
      deps.store
        .getState()
        .setError(hostId, error instanceof Error ? error.message : String(error));
      deps.reportFailure(hostId, error);
      return false;
    }
  };
}
