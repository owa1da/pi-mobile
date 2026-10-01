import { beforeEach, describe, expect, it } from "vitest";
import { createHostsStore, HOSTS_STORAGE_KEY, HostDraftInvalidError } from "./hosts-store";
import { createMemorySecretStore, secretKeyFor } from "./secret-store";
import { hostAddress, parsePort, parseRecords, secretToAuth } from "./host-records";

function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => Promise.resolve(entries.get(key) ?? null),
    setItem: (key: string, value: string) => {
      entries.set(key, value);
      return Promise.resolve();
    },
  };
}

const draft = { label: "Desk", host: "10.0.0.2", port: 22, username: "me" };
const PRIVATE = "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n-----END OPENSSH PRIVATE KEY-----";

describe("hosts store", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let secrets: ReturnType<typeof createMemorySecretStore>;
  let ids: number;
  const make = () =>
    createHostsStore({ storage, secrets, newId: () => `h${++ids}`, now: () => 1000 });

  beforeEach(() => {
    storage = memoryStorage();
    secrets = createMemorySecretStore();
    ids = 0;
  });

  it("adds a host with its secret in the secret store, never in the record", async () => {
    const store = make();
    const host = await store
      .getState()
      .addHost(draft, { kind: "generated", privateKey: PRIVATE, publicKey: "ssh-ed25519 AAA pi" });
    expect(host).toMatchObject({ id: "h1", authType: "key", secretRef: "h1", createdAt: 1000 });
    const persisted = storage.entries.get(HOSTS_STORAGE_KEY) ?? "";
    expect(persisted).toContain("10.0.0.2");
    expect(persisted).not.toContain("SECRET");
    expect(persisted).not.toContain("ssh-ed25519");
    expect(secrets.entries.get(secretKeyFor("h1"))).toContain("SECRET");
    expect(await store.getState().loadSecret("h1")).toMatchObject({ kind: "generated" });
  });

  it("drops secret fields smuggled into a record when persisting and loading", async () => {
    const store = make();
    await store.getState().addHost(draft, { kind: "password", password: "hunter2" });
    const smuggled = [{ ...store.getState().hosts[0], password: "hunter2", privateKey: "X" }];
    storage.entries.set(HOSTS_STORAGE_KEY, JSON.stringify(smuggled));
    const reloaded = make();
    await reloaded.getState().load();
    expect(reloaded.getState().hosts[0]).not.toHaveProperty("password");
    expect(reloaded.getState().hosts[0]).not.toHaveProperty("privateKey");
    expect(parseRecords(JSON.stringify(smuggled))[0]).not.toHaveProperty("password");
  });

  it("rejects invalid drafts and writes nothing", async () => {
    const store = make();
    await expect(
      store
        .getState()
        .addHost({ ...draft, host: " ", port: 0 }, { kind: "password", password: "x" }),
    ).rejects.toBeInstanceOf(HostDraftInvalidError);
    expect(store.getState().hosts).toHaveLength(0);
    expect(secrets.entries.size).toBe(0);
  });

  it("edits keep the secret unless a new one is given, and a new address drops the pin", async () => {
    const store = make();
    await store.getState().addHost(draft, { kind: "password", password: "one" });
    await store.getState().pinHostKey("h1", "SHA256:abc");
    await store.getState().updateHost("h1", { ...draft, label: "Renamed" });
    expect(store.getState().getHost("h1")).toMatchObject({
      label: "Renamed",
      hostKeyFingerprint: "SHA256:abc",
    });
    expect(await store.getState().loadSecret("h1")).toEqual({ kind: "password", password: "one" });

    await store
      .getState()
      .updateHost("h1", { ...draft, host: "10.0.0.3" }, { kind: "pasted", privateKey: PRIVATE });
    const host = store.getState().getHost("h1");
    expect(host?.hostKeyFingerprint).toBeUndefined();
    expect(host?.authType).toBe("key");
    expect(await store.getState().loadSecret("h1")).toMatchObject({ kind: "pasted" });
  });

  it("deletes the record and its secret", async () => {
    const store = make();
    await store.getState().addHost(draft, { kind: "password", password: "one" });
    await store.getState().removeHost("h1");
    expect(store.getState().hosts).toEqual([]);
    expect(secrets.entries.size).toBe(0);
    expect(storage.entries.get(HOSTS_STORAGE_KEY)).toBe("[]");
  });

  it("round-trips through storage", async () => {
    const store = make();
    await store.getState().addHost(draft, { kind: "password", password: "one" });
    await store.getState().markConnected("h1");
    const reloaded = make();
    await reloaded.getState().load();
    expect(reloaded.getState().loaded).toBe(true);
    expect(reloaded.getState().hosts[0]).toMatchObject({ id: "h1", lastConnectedAt: 1000 });
  });
});

describe("host records", () => {
  it("parses ports", () => {
    expect(parsePort("")).toBe(22);
    expect(parsePort("2222")).toBe(2222);
    expect(parsePort("0")).toBeNull();
    expect(parsePort("70000")).toBeNull();
    expect(parsePort("22a")).toBeNull();
  });

  it("maps secrets to SSH auth", () => {
    expect(secretToAuth({ kind: "password", password: "p" })).toEqual({
      type: "password",
      password: "p",
    });
    expect(secretToAuth({ kind: "pasted", privateKey: "k", passphrase: "pp" })).toEqual({
      type: "key",
      privateKey: "k",
      passphrase: "pp",
    });
    expect(secretToAuth({ kind: "generated", privateKey: "k", publicKey: "pub" })).toEqual({
      type: "key",
      privateKey: "k",
    });
  });

  it("formats the address with a non-default port only", () => {
    expect(hostAddress({ host: "box", port: 22, username: "me" })).toBe("me@box");
    expect(hostAddress({ host: "box", port: 2222, username: "me" })).toBe("me@box:2222");
  });
});
