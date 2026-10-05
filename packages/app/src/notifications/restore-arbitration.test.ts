import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationNavigation } from "./navigation";
const fake = vi.hoisted(() => ({
  effect: undefined as (() => void) | undefined,
  cold: Promise.resolve(),
  allowed: true,
  loaded: true,
  ready: true,
  getItem: vi.fn(),
  removeItem: vi.fn(),
  push: vi.fn(),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void) => {
    fake.effect = effect;
  },
}));
vi.mock("expo-router", () => ({
  router: { push: fake.push },
  useRootNavigationState: () => (fake.ready ? { key: "root" } : undefined),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: fake.getItem, removeItem: fake.removeItem },
}));
vi.mock("@/stores/app", () => ({
  useHostsLoaded: () => fake.loaded,
  hostsStore: {
    getState: () => ({
      getHost: (id: string) => (id === "h" ? { id, hostKeyFingerprint: "trusted" } : undefined),
    }),
  },
}));
vi.mock("./runtime", () => ({
  notificationStartup: fake.cold,
  notificationNavigation: { canRestore: () => fake.allowed },
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fake.allowed = true;
  fake.loaded = true;
  fake.ready = true;
  fake.cold = Promise.resolve();
  fake.removeItem.mockResolvedValue(undefined);
  fake.getItem.mockResolvedValue(
    JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      place: { kind: "session", hostId: "h", sessionId: "saved" },
    }),
  );
});

describe("saved-place arbitration wiring", () => {
  it("waits for cold response collection, then lets a valid notification outrank restore", async () => {
    let finish!: () => void;
    fake.cold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { PlaceRestorer } = await import("@/navigation/place-restorer");
    PlaceRestorer();
    fake.effect!();
    expect(fake.getItem).not.toHaveBeenCalled();
    const nav = createNotificationNavigation(() => true, vi.fn());
    nav.receive({ hostId: "h", sessionId: "tap", eventId: "e", kind: "finished" });
    fake.allowed = nav.canRestore();
    finish();
    await vi.waitFor(() => expect(fake.removeItem).toHaveBeenCalled());
    expect(fake.push).not.toHaveBeenCalled();
  });
  it("unknown-host notifications leave saved restoration intact", async () => {
    const nav = createNotificationNavigation(() => false, vi.fn());
    nav.receive({ hostId: "gone", sessionId: "tap", eventId: "e", kind: "finished" });
    fake.allowed = nav.canRestore();
    const { PlaceRestorer } = await import("@/navigation/place-restorer");
    PlaceRestorer();
    fake.effect!();
    await vi.waitFor(() => expect(fake.push).toHaveBeenCalledTimes(2));
    expect(fake.push.mock.calls[1]![0].params.sessionId).toBe("saved");
  });
  it("a warm tap during storage read also wins; navigator readiness gates restoration", async () => {
    let finish!: (value: string) => void;
    const saved = await fake.getItem();
    fake.getItem.mockClear();
    fake.getItem.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    fake.ready = false;
    const { PlaceRestorer } = await import("@/navigation/place-restorer");
    PlaceRestorer();
    fake.effect!();
    expect(fake.getItem).not.toHaveBeenCalled();
    fake.ready = true;
    PlaceRestorer();
    fake.effect!();
    await vi.waitFor(() => expect(fake.getItem).toHaveBeenCalled());
    fake.allowed = false;
    finish(saved);
    await vi.waitFor(() => expect(fake.removeItem).toHaveBeenCalled());
    expect(fake.push).not.toHaveBeenCalled();
  });
});
