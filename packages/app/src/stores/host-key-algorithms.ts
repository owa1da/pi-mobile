// Which key type (ssh-ed25519, rsa-sha2-512, …) each host key fingerprint the app has seen belongs
// to, so a fingerprint can be labelled "ED25519 · SHA256" later, e.g. the pinned key on the
// changed-key sheet. A fingerprint and its key type are public facts: no secrets, no trust. Kept
// apart from SavedHost (a fixed contract); an unknown fingerprint simply gets no key-type label.

export interface AlgorithmStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export const HOST_KEY_ALGORITHMS_KEY = "pi.hostKeyAlgorithms.v1";
/** Newest entries win; a phone sees a handful of hosts, so this never evicts a pin in practice. */
export const HOST_KEY_ALGORITHMS_MAX = 64;

export interface HostKeyAlgorithms {
  load(): Promise<void>;
  note(fingerprint: string, algorithm: string): void;
  algorithmOf(fingerprint: string | undefined): string | undefined;
}

function parseEntries(raw: string | null): [string, string][] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    );
  } catch {
    return [];
  }
}

export function createHostKeyAlgorithms(storage: AlgorithmStorage): HostKeyAlgorithms {
  const map = new Map<string, string>();
  let loading: Promise<void> | null = null;

  const persist = () => {
    const entries = [...map.entries()].slice(-HOST_KEY_ALGORITHMS_MAX);
    void storage.setItem(HOST_KEY_ALGORITHMS_KEY, JSON.stringify(entries)).catch(() => undefined);
  };

  return {
    load() {
      loading ??= storage.getItem(HOST_KEY_ALGORITHMS_KEY).then(
        (raw) => {
          // Entries noted before the load finished are newer: keep them on top.
          const noted = [...map.entries()];
          map.clear();
          for (const [fp, algorithm] of [...parseEntries(raw), ...noted]) map.set(fp, algorithm);
          return undefined;
        },
        () => undefined,
      );
      return loading;
    },
    note(fingerprint, algorithm) {
      if (!fingerprint || !algorithm || map.get(fingerprint) === algorithm) return;
      map.delete(fingerprint);
      map.set(fingerprint, algorithm);
      while (map.size > HOST_KEY_ALGORITHMS_MAX) map.delete(map.keys().next().value as string);
      persist();
    },
    algorithmOf(fingerprint) {
      return fingerprint ? map.get(fingerprint) : undefined;
    },
  };
}
