// App-wide singletons: saved hosts (AsyncStorage + expo-secure-store), one SSH connection and
// host service per host, and the latest session snapshot per host. Screens read them through the
// hooks below; the stores themselves are React-free and unit-tested with fakes.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { useStore } from "zustand";
import { createHostService, type PiHostService } from "@/host";
import type { SavedHost } from "@/host/types";
import { getSshClient } from "@/ssh";
import { createConnectionStore, type HostConnectionState } from "./connection-store";
import { createHostKeyAlgorithms } from "./host-key-algorithms";
import { secretToAuth } from "./host-records";
import { createHostsStore } from "./hosts-store";
import type { SecretStore } from "./secret-store";
import { createSessionsRefresher, createSessionsStore, type SessionsEntry } from "./sessions-store";

const secureSecrets: SecretStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
};

export const hostsStore = createHostsStore({
  storage: AsyncStorage,
  secrets: secureSecrets,
  newId: () => randomUUID(),
});

/** Key type per seen fingerprint (labels the pinned key on the changed-key sheet). */
export const hostKeyAlgorithms = createHostKeyAlgorithms(AsyncStorage);

export const connectionStore = createConnectionStore<PiHostService>({
  client: getSshClient,
  createService: (connection) => createHostService(connection),
  getHost: (id) => hostsStore.getState().getHost(id),
  loadAuth: async (id) => {
    const secret = await hostsStore.getState().loadSecret(id);
    return secret ? secretToAuth(secret) : null;
  },
  pinHostKey: (id, fingerprint) => hostsStore.getState().pinHostKey(id, fingerprint),
  markConnected: (id) => hostsStore.getState().markConnected(id),
  noteHostKey: (key) => hostKeyAlgorithms.note(key.fingerprint, key.algorithm),
});

export const sessionsStore = createSessionsStore();

export const refreshSessions = createSessionsRefresher({
  getService: (hostId) => connectionStore.getState().getService(hostId),
  reportFailure: (hostId, error) => connectionStore.getState().reportFailure(hostId, error),
  store: sessionsStore,
});

const IDLE_CONNECTION: HostConnectionState = { status: "idle", attempt: 0 };

export function useHosts(): SavedHost[] {
  return useStore(hostsStore, (state) => state.hosts);
}

export function useHostsLoaded(): boolean {
  return useStore(hostsStore, (state) => state.loaded);
}

export function useHost(hostId: string | undefined): SavedHost | undefined {
  return useStore(hostsStore, (state) =>
    hostId ? state.hosts.find((host) => host.id === hostId) : undefined,
  );
}

export function useHostConnection(hostId: string | undefined): HostConnectionState {
  return useStore(connectionStore, (state) =>
    hostId ? (state.hosts[hostId] ?? IDLE_CONNECTION) : IDLE_CONNECTION,
  );
}

export function useHostKeyPrompt() {
  return useStore(connectionStore, (state) => state.prompt);
}

export function useSessionsEntry(hostId: string | undefined): SessionsEntry | undefined {
  return useStore(sessionsStore, (state) => (hostId ? state.entries[hostId] : undefined));
}
