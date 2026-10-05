/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "@/host/types";
import { useRemoteChannel } from "./use-remote-channel";
import { commandCatalogStore } from "@/stores/app";

const remote = vi.hoisted(() => ({ read: vi.fn(), state: vi.fn() }));
vi.mock("expo-router", () => ({ useFocusEffect: vi.fn() }));
vi.mock("@/remote", () => ({
  hasRemote: (row: SessionRow) => row.live && row.remote === 1 && Boolean(row.pid),
  remoteFor: () => ({ readState: remote.state }),
  hostSkewMs: vi.fn(),
  setHostSkew: vi.fn(),
}));
vi.mock("@/stores/app", async () => {
  const { createCommandCatalogStore } = await import("@/stores/command-catalog-store");
  const storage = {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  };
  return {
    commandCatalogStore: createCommandCatalogStore(storage),
    connectionStore: {
      getState: () => ({ getService: () => ({ readCommandCatalog: remote.read }) }),
    },
  };
});
const catalog = {
  v: 1 as const,
  updatedAt: 100,
  latest: { cwd: "/other", at: 100, commands: [{ name: "host-added", description: null }] },
  byCwd: { "/work": { at: 100, commands: [{ name: "cwd-command", description: null }] } },
};
const row = { live: false, sessionId: "session", cwd: "/work", pid: 42, remote: 1 } as SessionRow;

beforeEach(() => {
  vi.useFakeTimers();
  remote.read.mockReset().mockResolvedValue(catalog);
  remote.state.mockReset().mockResolvedValue({
    v: 1,
    pid: 42,
    rev: 1,
    updatedAt: 200,
    view: "main",
    commands: [{ name: "live-only", description: null }],
  });
  commandCatalogStore.setState({ phone: {}, remote: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("completed-screen catalog polling", () => {
  it("reads on open, then every 30s only when focused; shows cwd menu", async () => {
    const { result, rerender } = renderHook(
      ({ active }) => useRemoteChannel("h", row, undefined, active),
      { initialProps: { active: true } },
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(remote.read).toHaveBeenCalledTimes(1);
    expect(result.current.commands?.[0].name).toBe("cwd-command");
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(remote.read).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(remote.read).toHaveBeenCalledTimes(2);
    rerender({ active: false });
    await act(async () => vi.advanceTimersByTimeAsync(90_000));
    expect(remote.read).toHaveBeenCalledTimes(2);
    rerender({ active: true });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(remote.read).toHaveBeenCalledTimes(3);
  });
  it("live state stays the source; no catalog reads across live poll ticks or boosts", async () => {
    const { result, rerender } = renderHook(
      ({ live }) => useRemoteChannel("h", { ...row, live }, undefined, true),
      { initialProps: { live: true } },
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(remote.read).not.toHaveBeenCalled();
    expect(result.current.commands?.[0].name).toBe("live-only");
    act(() => result.current.boost());
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(remote.read).not.toHaveBeenCalled();
    rerender({ live: false });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(remote.read).toHaveBeenCalledTimes(1);
    rerender({ live: true });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(remote.read).toHaveBeenCalledTimes(1);
  });
});
