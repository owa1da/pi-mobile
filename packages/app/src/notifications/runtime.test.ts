import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DevicePushToken, Notification, NotificationResponse } from "expo-notifications";

const fake = vi.hoisted(() => ({
  values: new Map<string, string>(),
  hosts: new Set(["h"]),
  push: vi.fn(),
  exec: vi.fn(),
  response: undefined as ((r: NotificationResponse) => void) | undefined,
  token: undefined as ((token: DevicePushToken) => void) | undefined,
  connected: false,
  changed: undefined as (() => void) | undefined,
  handler: undefined as
    | { handleNotification(n: Notification): Promise<{ shouldShowBanner: boolean }> }
    | null
    | undefined,
  cold: undefined as NotificationResponse | null | undefined,
  place: { kind: "hosts" } as
    | { kind: "hosts" }
    | { kind: "session"; hostId: string; sessionId: string },
  granted: true,
  request: vi.fn(),
  removed: vi.fn(),
  action: "default",
}));
vi.mock("@/constants/platform", () => ({ isNative: true }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => fake.values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      fake.values.set(key, value);
    },
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "installation" }));
vi.mock("expo-router", () => ({ router: { push: fake.push } }));
vi.mock("react-native", () => ({ AppState: { currentState: "active" }, Platform: { OS: "ios" } }));
vi.mock("@/i18n/i18next", () => ({ i18n: { t: () => "Notifications" } }));
vi.mock("@/navigation/restore-place", () => ({ currentPlace: () => fake.place }));
vi.mock("@/host/service", () => ({ trustedHostConnection: () => ({ exec: fake.exec }) }));
vi.mock("@/stores/app", () => ({
  hostsStore: {
    getState: () => ({ getHost: (id: string) => (fake.hosts.has(id) ? { id } : undefined) }),
  },
  connectionStore: {
    getState: () => ({
      hosts: fake.connected ? { h: { status: "connected" } } : {},
      getService: () => (fake.connected ? service : null),
    }),
    subscribe: (listener: () => void) => {
      fake.changed = listener;
      return vi.fn();
    },
  },
}));
const service = { environment: async () => ({ agentDir: "/agent" }) };
vi.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "default",
  getPermissionsAsync: async () => ({ granted: fake.granted, canAskAgain: true }),
  requestPermissionsAsync: fake.request,
  getExpoPushTokenAsync: async () => ({ data: "never-log-token" }),
  getLastNotificationResponseAsync: async () => fake.cold ?? null,
  setNotificationHandler: (handler: typeof fake.handler) => {
    fake.handler = handler;
  },
  addNotificationResponseReceivedListener: (listener: typeof fake.response) => {
    fake.response = listener;
    return { remove: fake.removed };
  },
  addPushTokenListener: (listener: typeof fake.token) => {
    fake.token = listener;
    return { remove: fake.removed };
  },
}));
function response(eventId = "cold", hostId = "h"): NotificationResponse {
  return {
    actionIdentifier: "default",
    notification: {
      date: 0,
      request: {
        identifier: eventId,
        trigger: null,
        content: {
          title: "Session",
          subtitle: null,
          body: "Finished",
          sound: null,
          categoryIdentifier: null,
          data: { hostId, sessionId: "s", eventId, kind: "finished" },
        },
      },
    },
  };
}
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fake.values.clear();
  fake.hosts = new Set(["h"]);
  fake.connected = false;
  fake.granted = true;
  fake.cold = null;
  fake.handler = undefined;
  fake.place = { kind: "hosts" };
  fake.exec.mockResolvedValue({ exitCode: 0 });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

describe("native notification lifecycle", () => {
  it("collects cold start before restore; waits for hosts and navigator; warm dedupe and unknown host", async () => {
    fake.cold = response();
    const runtime = await import("./runtime");
    stop = runtime.startNotifications();
    await runtime.notificationStartup;
    expect(fake.request).not.toHaveBeenCalled();
    expect(runtime.notificationNavigation.canRestore()).toBe(false);
    expect(fake.push).not.toHaveBeenCalled();
    runtime.flushNotificationNavigation(true, false);
    expect(fake.push).not.toHaveBeenCalled();
    await runtime.flushNotificationNavigation(true, true);
    expect(fake.push).toHaveBeenCalledTimes(1);
    fake.response!(response());
    fake.response!(response("warm"));
    fake.response!(response("unknown", "deleted"));
    await vi.waitFor(() => expect(fake.push).toHaveBeenCalledTimes(2));
    expect(fake.exec).not.toHaveBeenCalled();
  });
  it("does not reclaim a consumed cold notification after a JS reload", async () => {
    fake.cold = response("retained");
    const first = await import("./runtime");
    stop = first.startNotifications();
    await first.notificationStartup;
    await first.flushNotificationNavigation(true, true);
    await vi.waitFor(() => expect(fake.push).toHaveBeenCalledTimes(1));
    fake.place = { kind: "session", hostId: "h", sessionId: "visited-B" };
    stop();
    stop = undefined;
    vi.resetModules();
    const reloaded = await import("./runtime");
    stop = reloaded.startNotifications();
    await reloaded.notificationStartup;
    await reloaded.flushNotificationNavigation(true, true);
    expect(fake.push).toHaveBeenCalledTimes(1);
    expect(reloaded.notificationNavigation.canRestore()).toBe(true);
  });
  it("foreground same-session suppression, other-session alerts, and local opt-out", async () => {
    const runtime = await import("./runtime");
    stop = runtime.startNotifications();
    await runtime.notificationStartup;
    await runtime.notificationPreferences.setEnabled("h", true);
    fake.place = { kind: "session", hostId: "h", sessionId: "s" };
    expect((await fake.handler!.handleNotification(response().notification)).shouldShowBanner).toBe(
      false,
    );
    fake.place = { kind: "hosts" };
    expect((await fake.handler!.handleNotification(response().notification)).shouldShowBanner).toBe(
      true,
    );
    fake.hosts.clear();
    expect((await fake.handler!.handleNotification(response().notification)).shouldShowBanner).toBe(
      false,
    );
  });
  it("renews on trusted connection and token change, and removes before forgetting", async () => {
    const runtime = await import("./runtime");
    stop = runtime.startNotifications();
    await runtime.notificationStartup;
    await runtime.notificationPreferences.setEnabled("h", true);
    expect(fake.exec).not.toHaveBeenCalled();
    fake.connected = true;
    fake.changed!();
    await vi.waitFor(() => expect(fake.exec).toHaveBeenCalledTimes(1));
    const tokenChanged = vi.spyOn(runtime.notificationPreferences, "tokenChanged");
    fake.token!({ type: "ios", data: "native-new" });
    fake.token!({ type: "ios", data: "native-new" });
    expect(tokenChanged).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fake.exec).toHaveBeenCalledTimes(2));
    await runtime.forgetHostNotifications("h");
    expect(fake.exec).toHaveBeenCalledTimes(3);
    const script = Buffer.from(
      fake.exec.mock.calls[2]![0].match(/printf %s ([A-Za-z0-9+/=]+)/)![1],
      "base64",
    ).toString();
    expect(script).toContain("rm -f");
    expect(runtime.notificationPreferences.getState().enabled.h).not.toBe(true);
  });
  it("bounds deletion even if SSH never resolves", async () => {
    vi.useFakeTimers();
    const runtime = await import("./runtime");
    stop = runtime.startNotifications();
    await runtime.notificationStartup;
    fake.connected = true;
    fake.exec.mockImplementation(() => new Promise(() => {}));
    const deletion = runtime.forgetHostNotifications("h");
    await vi.advanceTimersByTimeAsync(4000);
    await deletion;
  });
});
