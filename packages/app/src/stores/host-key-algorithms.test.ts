import { describe, expect, it } from "vitest";
import {
  HOST_KEY_ALGORITHMS_KEY,
  HOST_KEY_ALGORITHMS_MAX,
  createHostKeyAlgorithms,
  type AlgorithmStorage,
} from "./host-key-algorithms";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: AlgorithmStorage = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
  };
  return { storage, data };
}

describe("host key algorithms", () => {
  it("remembers the key type of a seen fingerprint across a restart", async () => {
    const { storage, data } = memoryStorage();
    const first = createHostKeyAlgorithms(storage);
    await first.load();
    first.note("SHA256:aaa", "ssh-ed25519");
    expect(first.algorithmOf("SHA256:aaa")).toBe("ssh-ed25519");
    await Promise.resolve();
    expect(data.get(HOST_KEY_ALGORITHMS_KEY)).toContain("SHA256:aaa");

    const second = createHostKeyAlgorithms(storage);
    await second.load();
    expect(second.algorithmOf("SHA256:aaa")).toBe("ssh-ed25519");
  });

  it("knows nothing about an unseen fingerprint and never guesses", async () => {
    const store = createHostKeyAlgorithms(memoryStorage().storage);
    await store.load();
    expect(store.algorithmOf("SHA256:nope")).toBeUndefined();
    expect(store.algorithmOf(undefined)).toBeUndefined();
  });

  it("ignores a malformed record and keeps keys noted before the load finished", async () => {
    const { storage } = memoryStorage({ [HOST_KEY_ALGORITHMS_KEY]: "{not json" });
    const store = createHostKeyAlgorithms(storage);
    store.note("SHA256:early", "rsa-sha2-512");
    await store.load();
    expect(store.algorithmOf("SHA256:early")).toBe("rsa-sha2-512");
  });

  it("caps the record, dropping the oldest", async () => {
    const store = createHostKeyAlgorithms(memoryStorage().storage);
    await store.load();
    for (let i = 0; i <= HOST_KEY_ALGORITHMS_MAX; i++) store.note(`SHA256:${i}`, "ssh-ed25519");
    expect(store.algorithmOf("SHA256:0")).toBeUndefined();
    expect(store.algorithmOf(`SHA256:${HOST_KEY_ALGORITHMS_MAX}`)).toBe("ssh-ed25519");
  });
});
