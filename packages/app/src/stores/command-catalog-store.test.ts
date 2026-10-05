import { describe, expect, it, vi } from "vitest";
import {
  createCommandCatalogStore,
  catalogStorageKey,
  refreshCommandCatalog,
  completedCommands,
} from "./command-catalog-store";
import { createHostsStore } from "./hosts-store";
import { createMemorySecretStore } from "./secret-store";
import { parseCommandCatalog, CATALOG_MAX_BYTES } from "@/remote/command-catalog";

const catalog = (updatedAt = 100) =>
  parseCommandCatalog(
    JSON.stringify({
      v: 1,
      updatedAt,
      latest: {
        cwd: "/other",
        at: updatedAt,
        commands: [{ name: "latest", description: "Latest" }],
      },
      byCwd: { "/work": { at: updatedAt, commands: [{ name: "local", description: "Local" }] } },
    }),
  )!;
const memory = () => {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: async (key: string) => entries.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: async (key: string) => {
      entries.delete(key);
    },
  };
};

describe("phone command discovery", () => {
  it("persists across a fresh store/relaunch and isolates saved hosts", async () => {
    const storage = memory();
    const first = createCommandCatalogStore(storage);
    await first.getState().accept("host", catalog());
    const relaunched = createCommandCatalogStore(storage);
    await relaunched.getState().load("host");
    expect(completedCommands(relaunched.getState(), "host", "/work")?.[0].name).toBe("local");
    expect(completedCommands(relaunched.getState(), "host", "/missing")?.[0].name).toBe("latest");
    expect(completedCommands(relaunched.getState(), "other", "/work")).toBeUndefined();
  });
  it("prefers freshest exact cwd before latest, then the in-memory list", async () => {
    const store = createCommandCatalogStore(memory());
    await store.getState().accept("h", catalog());
    const newer = catalog(200);
    newer.latest.commands = [{ name: "new", description: null }];
    await store.getState().accept("h", newer);
    expect(completedCommands(store.getState(), "h", "/missing")?.[0].name).toBe("new");
    newer.byCwd = {};
    expect(
      completedCommands({ remote: { h: newer }, phone: { h: catalog() } }, "h", "/work")?.[0].name,
    ).toBe("local");
    const fallback = [{ name: "memory", description: null }];
    expect(completedCommands(store.getState(), "absent", "/work", fallback)).toBe(fallback);
  });
  it("retains newer cwd entries, and persists main live lists including empty ones", async () => {
    const storage = memory();
    const store = createCommandCatalogStore(storage);
    await store.getState().accept("h", catalog(200));
    await store.getState().accept("h", catalog(100));
    expect(store.getState().phone.h.updatedAt).toBe(200);
    await store
      .getState()
      .rememberLive("h", "/work", { view: "side", updatedAt: 300, commands: [] });
    expect(completedCommands(store.getState(), "h", "/work")?.[0].name).toBe("local");
    await store
      .getState()
      .rememberLive("h", "/work", { view: "main", updatedAt: 300, commands: [] });
    expect(completedCommands(store.getState(), "h", "/work")).toEqual([]);
    await store.getState().rememberLive("h", "/added", {
      view: "main",
      updatedAt: 400,
      commands: [{ name: "laptop-added", description: null }],
    });
    const fresh = createCommandCatalogStore(storage);
    await fresh.getState().load("h");
    expect(completedCommands(fresh.getState(), "h", "/work")).toEqual([]);
    expect(completedCommands(fresh.getState(), "h", "/added")?.[0].name).toBe("laptop-added");
  });
  it("reconciles host and phone freshness per cwd instead of discarding an older snapshot", async () => {
    const storage = memory();
    const store = createCommandCatalogStore(storage);
    await store.getState().rememberLive("h", "/a", {
      view: "main",
      updatedAt: 300,
      commands: [{ name: "phone-a", description: null }],
    });
    const host = catalog(200);
    host.byCwd = {
      "/a": { at: 100, commands: [{ name: "host-a", description: null }] },
      "/b": { at: 200, commands: [{ name: "host-b", description: null }] },
    };
    await store.getState().accept("h", host);
    expect(completedCommands(store.getState(), "h", "/b")?.[0].name).toBe("host-b");
    expect(store.getState().remote.h).toBe(host);
    expect(completedCommands(store.getState(), "h", "/a")?.[0].name).toBe("phone-a");
    expect(completedCommands(store.getState(), "h", "/unknown")?.[0].name).toBe("phone-a");
    await store.getState().rememberLive("h", "/a", {
      view: "main",
      updatedAt: 400,
      commands: [{ name: "new-phone-a", description: null }],
    });
    expect(store.getState().remote.h).toBe(host);
    expect(completedCommands(store.getState(), "h", "/b")?.[0].name).toBe("host-b");
    const relaunched = createCommandCatalogStore(storage);
    await relaunched.getState().load("h");
    expect(completedCommands(relaunched.getState(), "h", "/b")?.[0].name).toBe("host-b");
    host.byCwd["/a"] = { at: 500, commands: [{ name: "new-host-a", description: null }] };
    await store.getState().accept("h", host);
    expect(completedCommands(store.getState(), "h", "/a")?.[0].name).toBe("new-host-a");
  });

  it("keeps an older host latest cwd after an offline relaunch when the phone latest is newer", async () => {
    const storage = memory();
    const store = createCommandCatalogStore(storage);
    await store.getState().rememberLive("h", "/a", {
      view: "main",
      updatedAt: 300,
      commands: [{ name: "phone-a", description: null }],
    });
    const host = parseCommandCatalog(
      JSON.stringify({
        v: 1,
        updatedAt: 200,
        latest: { cwd: "/b", at: 200, commands: [{ name: "host-b", description: null }] },
        byCwd: {},
      }),
    )!;
    await store.getState().accept("h", host);
    const relaunched = createCommandCatalogStore(storage);
    await relaunched.getState().load("h");
    expect(completedCommands(relaunched.getState(), "h", "/b")?.[0].name).toBe("host-b");
    expect(completedCommands(relaunched.getState(), "h", "/a")?.[0].name).toBe("phone-a");
  });

  it("refreshes entry freshness even when live command names are unchanged", async () => {
    const store = createCommandCatalogStore(memory());
    const live = { view: "main" as const, commands: [{ name: "phone", description: null }] };
    await store.getState().rememberLive("h", "/work", { ...live, updatedAt: 100 });
    await store.getState().rememberLive("h", "/work", { ...live, updatedAt: 300 });
    await store.getState().accept("h", catalog(200));
    expect(completedCommands(store.getState(), "h", "/work")?.[0].name).toBe("phone");
  });

  it("never reads catalogs while a session is live", async () => {
    const store = createCommandCatalogStore(memory());
    const read = vi.fn(async () => catalog());
    await refreshCommandCatalog(store, "h", { readCommandCatalog: read }, () => true);
    expect(read).not.toHaveBeenCalled();
    await refreshCommandCatalog(store, "h", { readCommandCatalog: read }, () => false);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("legacy absent file keeps the phone or memory fallback", async () => {
    const store = createCommandCatalogStore(memory());
    await store.getState().accept("h", catalog());
    await refreshCommandCatalog(store, "h", { readCommandCatalog: async () => undefined });
    expect(completedCommands(store.getState(), "h", "/work")?.[0].name).toBe("local");
    await refreshCommandCatalog(store, "legacy", { readCommandCatalog: async () => undefined });
    const remembered = [{ name: "memory", description: null }];
    expect(completedCommands(store.getState(), "legacy", "/work", remembered)).toBe(remembered);
  });
  it("host deletion clears the phone, memory state, and disk", async () => {
    const storage = memory();
    const store = createCommandCatalogStore(storage);
    const hosts = createHostsStore({
      storage,
      secrets: createMemorySecretStore(),
      newId: () => "h",
      onRemoveHost: (id) => store.getState().remove(id),
    });
    await hosts
      .getState()
      .addHost(
        { label: "Host", host: "localhost", port: 22, username: "test" },
        { kind: "password", password: "test" },
      );
    await store.getState().accept("h", catalog());
    await hosts.getState().removeHost("h");
    expect(store.getState().phone.h).toBeUndefined();
    expect(store.getState().remote.h).toBeUndefined();
    expect(storage.entries.has(catalogStorageKey("h"))).toBe(false);
    const fresh = createCommandCatalogStore(storage);
    await fresh.getState().load("h");
    expect(completedCommands(fresh.getState(), "h", "/work")).toBeUndefined();
  });
  it("bounds persisted catalogs after many live cwd updates", async () => {
    const storage = memory();
    const store = createCommandCatalogStore(storage);
    for (let i = 0; i < 40; i++)
      await store.getState().rememberLive("h", `/work${i}`, {
        view: "main",
        updatedAt: i + 1,
        commands: Array.from({ length: 300 }, (_, j) => ({
          name: `c${j}`,
          description: "é".repeat(200),
        })),
      });
    const text = storage.entries.get(catalogStorageKey("h"))!;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CATALOG_MAX_BYTES);
    expect(Object.keys(store.getState().phone.h.byCwd).length).toBeLessThanOrEqual(32);
    expect(parseCommandCatalog(text)).toBeDefined();
  });
});
