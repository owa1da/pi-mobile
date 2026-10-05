import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import type { NotificationResponse } from "expo-notifications";
import { router } from "expo-router";
import { AppState, Platform } from "react-native";
import { isNative } from "@/constants/platform";
import { trustedHostConnection } from "@/host/service";
import { i18n } from "@/i18n/i18next";
import { currentPlace } from "@/navigation/restore-place";
import { connectionStore, hostsStore } from "@/stores/app";
import { createNotificationNavigation, notificationBehavior, parsePushData } from "./navigation";
import { createNotificationPreferences } from "./preferences";
import { registerDevice, unregisterDevice } from "./register";

// Native module is loaded only on native; web and host settings tests need no push runtime.
const notifications = () => import("expo-notifications");
const deleting = new Set<string>();
function registrationService(hostId: string) {
  const service = connectionStore.getState().getService(hostId);
  if (!service || !hostsStore.getState().getHost(hostId)) return null;
  return { environment: () => service.environment(), connection: trustedHostConnection(service) };
}
export const notificationPreferences = createNotificationPreferences({
  storage: AsyncStorage,
  api: {
    async getPermissionsAsync() {
      const api = await notifications();
      // Android 13 needs a visible channel before the explicit permission request/token call.
      if (Platform.OS === "android") {
        await api.setNotificationChannelAsync("default", {
          name: i18n.t("pi.notifications.title"),
          importance: api.AndroidImportance.DEFAULT,
        });
      }
      return api.getPermissionsAsync();
    },
    requestPermissionsAsync: async (options) =>
      (await notifications()).requestPermissionsAsync(options),
    getExpoPushTokenAsync: async (options) =>
      (await notifications()).getExpoPushTokenAsync(options),
  },
  newId: randomUUID,
  async register(hostId, installationId, token) {
    if (deleting.has(hostId)) return;
    const service = registrationService(hostId);
    // Offline opt-in is saved and registered on the next successful trusted connection.
    if (service) await registerDevice(service, installationId, hostId, token);
  },
  async unregister(hostId, installationId) {
    const service = registrationService(hostId);
    if (service) await unregisterDevice(service, installationId, hostId);
  },
});
export const notificationNavigation = createNotificationNavigation(
  (id) => Boolean(hostsStore.getState().getHost(id)) && !deleting.has(id),
  (route) => router.push(route),
  AsyncStorage,
);

let hostsReady = false;
let navigationReady = false;
export function flushNotificationNavigation(loaded: boolean, ready: boolean) {
  hostsReady = loaded;
  navigationReady = ready;
  return Promise.resolve(notificationNavigation.flush(loaded, ready)).catch(() => undefined);
}
let finishStartup: () => void;
export const notificationStartup = new Promise<void>((resolve) => {
  finishStartup = resolve;
});
let coldStarted = false;

/** Starts listeners, not permissions. Cold response collection arbitrates saved-place restore. */
export function startNotifications(): () => void {
  if (!isNative) {
    finishStartup();
    return () => {};
  }
  let stopped = false;
  let cleanNative = () => {};
  void notifications()
    .then(async (Notifications) => {
      await notificationNavigation.load();
      if (stopped) return undefined;
      Notifications.setNotificationHandler({
        async handleNotification(notification) {
          const data = notification.request.content.data;
          const parsed = parsePushData(data);
          const saved = parsed ? hostsStore.getState().getHost(parsed.hostId) : undefined;
          const enabled = parsed
            ? notificationPreferences.getState().enabled[parsed.hostId]
            : false;
          return notificationBehavior(
            data,
            AppState.currentState === "active",
            currentPlace(),
            Boolean(parsed && saved && enabled && !deleting.has(parsed.hostId)),
          );
        },
      });
      const receive = (response: NotificationResponse | null) => {
        if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER)
          return;
        notificationNavigation.receive(response.notification.request.content.data);
        return notificationNavigation.flush(hostsReady, navigationReady);
      };
      const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
        void Promise.resolve(receive(response)).catch(() => undefined);
      });
      let lastDeviceToken: string | undefined;
      const tokenSub = Notifications.addPushTokenListener((token) => {
        // Requesting the Expo token can itself deliver the same native token callback.
        // Only an actual native token change renews leases, avoiding a registration loop.
        const identity = JSON.stringify(token);
        if (identity === lastDeviceToken) return;
        lastDeviceToken = identity;
        void notificationPreferences.tokenChanged().catch(() => undefined);
      });
      if (!coldStarted) {
        coldStarted = true;
        void Notifications.getLastNotificationResponseAsync()
          .then(receive)
          .catch(() => undefined)
          .finally(() => finishStartup());
      }
      let previous = new Map<string, unknown>();
      const renewConnections = () => {
        const next = new Map<string, unknown>();
        for (const [id, entry] of Object.entries(connectionStore.getState().hosts)) {
          if (entry.status !== "connected" || deleting.has(id)) continue;
          const service = connectionStore.getState().getService(id);
          if (!service) continue;
          next.set(id, service);
          if (previous.get(id) !== service)
            void notificationPreferences.renew(id).catch(() => undefined);
        }
        previous = next;
      };
      const unsubscribe = connectionStore.subscribe(renewConnections);
      void notificationPreferences
        .load()
        .then(renewConnections)
        .catch(() => undefined);
      cleanNative = () => {
        responseSub.remove();
        tokenSub.remove();
        unsubscribe();
        Notifications.setNotificationHandler(null);
      };
      return undefined;
    })
    .catch(() => finishStartup());
  return () => {
    stopped = true;
    cleanNative();
  };
}

/** Must run before disconnect. Offline/unresponsive hosts are covered by the 30-day lease. */
export async function forgetHostNotifications(hostId: string): Promise<void> {
  deleting.add(hostId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      notificationPreferences.forget(hostId).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 4000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
