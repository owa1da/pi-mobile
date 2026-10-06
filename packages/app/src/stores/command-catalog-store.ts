// Non-secret, bounded discovery per saved host. Never used by command routing/authorization.
import { createStore } from "zustand/vanilla";
import {
  boundCommandCatalog,
  CATALOG_MAX_COMMANDS,
  parseCommandCatalog,
  type CatalogEntry,
  type CommandCatalog,
} from "@/remote/command-catalog";
import { parseCommand } from "@/remote/parse";
import type { RemoteCommand, RemoteState } from "@/remote/types";
import type { KeyValueStore } from "./secret-store";

export const CATALOG_POLL_MS = 30_000;
export const catalogStorageKey = (hostId: string) => `pi.commands.v1.${hostId}`;
interface CatalogState {
  phone: Record<string, CommandCatalog>;
  remote: Record<string, CommandCatalog>;
  load(hostId: string): Promise<void>;
  accept(hostId: string, catalog: CommandCatalog | undefined): Promise<void>;
  rememberLive(
    hostId: string,
    cwd: string,
    state: Pick<RemoteState, "view" | "updatedAt" | "commands"> | undefined,
  ): Promise<void>;
  remove(hostId: string): Promise<void>;
}
function sameLiveCommands(
  previous: CommandCatalog | undefined,
  cwd: string,
  commands: RemoteCommand[],
): boolean {
  return (
    previous?.latest.cwd === cwd &&
    JSON.stringify(previous.byCwd[cwd]?.commands) === JSON.stringify(commands) &&
    JSON.stringify(previous.latest.commands) === JSON.stringify(commands)
  );
}

function freshest<T extends CatalogEntry>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  return b && b.at > a.at ? b : a;
}

function cwdEntry(catalog: CommandCatalog | undefined, cwd: string): CatalogEntry | undefined {
  if (!catalog) return undefined;
  const entry = Object.hasOwn(catalog.byCwd, cwd) ? catalog.byCwd[cwd] : undefined;
  return freshest(entry, catalog.latest.cwd === cwd ? catalog.latest : undefined);
}

/** Each snapshot's latest is also an entry for its cwd; fold it in before merging. */
function entries(catalog: CommandCatalog): [string, CatalogEntry][] {
  const { cwd, ...latest } = catalog.latest;
  const byCwd = new Map(Object.entries(catalog.byCwd));
  byCwd.set(cwd, freshest(byCwd.get(cwd), latest)!);
  return [...byCwd];
}

function mergeCatalog(phone: CommandCatalog | undefined, remote: CommandCatalog): CommandCatalog {
  if (!phone) return remote;
  const byCwd = new Map(entries(phone));
  for (const [cwd, entry] of entries(remote)) byCwd.set(cwd, freshest(byCwd.get(cwd), entry)!);
  return {
    v: 1,
    updatedAt: Math.max(phone.updatedAt, remote.updatedAt),
    latest: freshest(remote.latest, phone.latest)!,
    byCwd: Object.fromEntries(byCwd),
  };
}

export function createCommandCatalogStore(
  storage: KeyValueStore & { removeItem(key: string): Promise<void> },
) {
  const writes = new Map<string, Promise<void>>();
  const removed = new Set<string>();
  const enqueue = (id: string, write: () => Promise<void>) => {
    const chain = (writes.get(id) ?? Promise.resolve()).catch(() => undefined).then(write);
    writes.set(id, chain);
    void chain
      .finally(() => {
        if (writes.get(id) === chain) writes.delete(id);
      })
      .catch(() => undefined);
    return chain;
  };
  return createStore<CatalogState>()((set, get) => {
    const persist = (hostId: string, next: CommandCatalog) => {
      const bounded = boundCommandCatalog(next);
      set((state) => ({ phone: { ...state.phone, [hostId]: bounded } }));
      return enqueue(hostId, () =>
        storage.setItem(catalogStorageKey(hostId), JSON.stringify(bounded)),
      );
    };
    return {
      phone: {},
      remote: {},
      async load(hostId) {
        const catalog = parseCommandCatalog(
          await storage.getItem(catalogStorageKey(hostId)).catch(() => null),
        );
        if (
          !removed.has(hostId) &&
          catalog &&
          (!get().phone[hostId] || catalog.updatedAt > get().phone[hostId].updatedAt)
        )
          set((state) => ({ phone: { ...state.phone, [hostId]: catalog } }));
      },
      async accept(hostId, catalog) {
        if (removed.has(hostId) || !catalog) return;
        // Snapshot freshness is not cwd freshness: an older host snapshot can add a new cwd.
        set((state) => ({ remote: { ...state.remote, [hostId]: catalog } }));
        await persist(hostId, mergeCatalog(get().phone[hostId], catalog));
      },
      async rememberLive(hostId, cwd, state) {
        if (removed.has(hostId) || !state?.commands || state.view !== "main") return;
        const commands = state.commands
          .slice(0, CATALOG_MAX_COMMANDS)
          .map(parseCommand)
          .filter((command): command is RemoteCommand => command !== null);
        const previous = get().phone[hostId];
        if (previous?.byCwd[cwd]?.at > state.updatedAt) return;
        if (previous?.latest.cwd === cwd && previous.latest.at > state.updatedAt) return;
        if (
          previous?.byCwd[cwd]?.at === state.updatedAt &&
          sameLiveCommands(previous, cwd, commands)
        )
          return;
        const entry = { at: state.updatedAt, commands };
        const next = boundCommandCatalog({
          v: 1,
          updatedAt: Math.max(previous?.updatedAt ?? 0, state.updatedAt),
          latest:
            previous && previous.latest.at > state.updatedAt ? previous.latest : { cwd, ...entry },
          byCwd: { ...previous?.byCwd, [cwd]: entry },
        });
        await persist(hostId, next);
      },
      async remove(hostId) {
        removed.add(hostId);
        const phone = { ...get().phone };
        const remote = { ...get().remote };
        delete phone[hostId];
        delete remote[hostId];
        set({ phone, remote });
        await enqueue(hostId, () => storage.removeItem(catalogStorageKey(hostId)));
      },
    };
  });
}
export type CommandCatalogStore = ReturnType<typeof createCommandCatalogStore>;
export function latestCommands(
  state: Pick<CatalogState, "remote" | "phone">,
  hostId: string,
  remembered?: readonly RemoteCommand[],
) {
  return (
    freshest(state.remote[hostId]?.latest, state.phone[hostId]?.latest)?.commands ?? remembered
  );
}

export function completedCommands(
  state: Pick<CatalogState, "remote" | "phone">,
  hostId: string,
  cwd: string,
  remembered?: readonly RemoteCommand[],
) {
  const remote = state.remote[hostId];
  const phone = state.phone[hostId];
  const exact = freshest(cwdEntry(remote, cwd), cwdEntry(phone, cwd));
  return exact?.commands ?? latestCommands(state, hostId, remembered);
}

/** Called on connection and by the slow focused-completed-screen poll, not the live state poll. */
export async function refreshCommandCatalog(
  store: CommandCatalogStore,
  hostId: string,
  service: { readCommandCatalog(): Promise<CommandCatalog | undefined> } | null,
  isLive: () => boolean = () => false,
): Promise<void> {
  if (!service || isLive()) return;
  try {
    const catalog = await service.readCommandCatalog();
    if (!isLive()) await store.getState().accept(hostId, catalog);
  } catch {
    // Discovery is optional; offline/legacy hosts keep the last good phone copy.
  }
}
