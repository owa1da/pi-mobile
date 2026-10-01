// Secure storage port for host secrets. The default implementation is expo-secure-store; tests
// pass an in-memory store.

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function createMemorySecretStore(): SecretStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: (key) => Promise.resolve(entries.get(key) ?? null),
    set: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}

/** expo-secure-store keys allow only [A-Za-z0-9._-]. */
export function secretKeyFor(secretRef: string): string {
  return `pi.host.${secretRef.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}
