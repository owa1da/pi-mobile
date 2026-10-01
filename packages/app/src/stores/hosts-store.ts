// Saved SSH hosts. Records go to a key-value store (AsyncStorage in the app); secrets go to a
// SecretStore (expo-secure-store in the app) under `secretKeyFor(record.secretRef)`.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { SavedHost } from "@/host/types";
import {
  authTypeOf,
  changesIdentity,
  normalizeDraft,
  parseRecords,
  parseSecret,
  serializeRecords,
  validateDraft,
  type HostDraft,
  type HostDraftError,
  type HostSecret,
} from "./host-records";
import { secretKeyFor, type KeyValueStore, type SecretStore } from "./secret-store";

export const HOSTS_STORAGE_KEY = "pi.hosts.v1";

export interface HostsStoreDeps {
  storage: KeyValueStore;
  secrets: SecretStore;
  newId: () => string;
  now?: () => number;
}

export class HostDraftInvalidError extends Error {
  constructor(readonly errors: HostDraftError[]) {
    super(`Invalid host: ${errors.join(", ")}`);
    this.name = "HostDraftInvalidError";
  }
}

export interface HostsState {
  hosts: SavedHost[];
  loaded: boolean;
  load(): Promise<void>;
  getHost(id: string): SavedHost | undefined;
  addHost(draft: HostDraft, secret: HostSecret): Promise<SavedHost>;
  /** `secret` undefined keeps the stored secret. */
  updateHost(id: string, draft: HostDraft, secret?: HostSecret): Promise<SavedHost>;
  removeHost(id: string): Promise<void>;
  loadSecret(id: string): Promise<HostSecret | null>;
  pinHostKey(id: string, fingerprint: string): Promise<void>;
  markConnected(id: string): Promise<void>;
}

export type HostsStore = StoreApi<HostsState>;

function assertValid(draft: HostDraft): HostDraft {
  const errors = validateDraft(draft);
  if (errors.length > 0) throw new HostDraftInvalidError(errors);
  return normalizeDraft(draft);
}

export function createHostsStore(deps: HostsStoreDeps): HostsStore {
  const now = deps.now ?? Date.now;
  // Writes are serialized so a slow write never lands after a newer one.
  let writeChain: Promise<void> = Promise.resolve();

  return createStore<HostsState>()((set, get) => {
    const persist = (hosts: SavedHost[]): Promise<void> => {
      set({ hosts });
      const payload = serializeRecords(hosts);
      writeChain = writeChain
        .catch(() => undefined)
        .then(() => deps.storage.setItem(HOSTS_STORAGE_KEY, payload));
      return writeChain;
    };

    const replace = (id: string, update: (host: SavedHost) => SavedHost): Promise<void> => {
      const hosts = get().hosts.map((host) => (host.id === id ? update(host) : host));
      return persist(hosts);
    };

    const requireHost = (id: string): SavedHost => {
      const host = get().getHost(id);
      if (!host) throw new Error(`Unknown host ${id}`);
      return host;
    };

    return {
      hosts: [],
      loaded: false,

      async load() {
        const json = await deps.storage.getItem(HOSTS_STORAGE_KEY);
        set({ hosts: parseRecords(json), loaded: true });
      },

      getHost: (id) => get().hosts.find((host) => host.id === id),

      async addHost(draft, secret) {
        const clean = assertValid(draft);
        const id = deps.newId();
        const record: SavedHost = {
          id,
          ...clean,
          authType: authTypeOf(secret),
          secretRef: id,
          createdAt: now(),
        };
        // Secret first: a record must never point at a missing secret.
        await deps.secrets.set(secretKeyFor(record.secretRef), JSON.stringify(secret));
        try {
          await persist([...get().hosts, record]);
        } catch (error) {
          await deps.secrets.remove(secretKeyFor(record.secretRef)).catch(() => undefined);
          set({ hosts: get().hosts.filter((host) => host.id !== id) });
          throw error;
        }
        return record;
      },

      async updateHost(id, draft, secret) {
        const before = requireHost(id);
        const clean = assertValid(draft);
        if (secret) await deps.secrets.set(secretKeyFor(before.secretRef), JSON.stringify(secret));
        const next: SavedHost = {
          ...before,
          ...clean,
          authType: secret ? authTypeOf(secret) : before.authType,
        };
        // A different machine (host or port) has a different key: drop the pin.
        if (changesIdentity(before, clean)) delete next.hostKeyFingerprint;
        await replace(id, () => next);
        return next;
      },

      async removeHost(id) {
        const host = get().getHost(id);
        if (!host) return;
        await persist(get().hosts.filter((item) => item.id !== id));
        await deps.secrets.remove(secretKeyFor(host.secretRef));
      },

      async loadSecret(id) {
        const host = get().getHost(id);
        if (!host) return null;
        return parseSecret(await deps.secrets.get(secretKeyFor(host.secretRef)));
      },

      pinHostKey: (id, fingerprint) =>
        replace(id, (host) => ({ ...host, hostKeyFingerprint: fingerprint })),

      markConnected: (id) => replace(id, (host) => ({ ...host, lastConnectedAt: now() })),
    };
  });
}
