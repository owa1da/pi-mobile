import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRootNavigationState } from "expo-router";
import { useTranslation } from "react-i18next";
import { Linking, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { isNative } from "@/constants/platform";
import { useHostsLoaded } from "@/stores/app";
import { MIN_TOUCH } from "@/styles/touch";
import { flushNotificationNavigation, notificationPreferences } from "./runtime";

export function NotificationNavigation() {
  const loaded = useHostsLoaded();
  const ready = Boolean(useRootNavigationState()?.key);
  useEffect(() => {
    flushNotificationNavigation(loaded, ready);
  }, [loaded, ready]);
  return null;
}

/** Same quiet form typography and controls as the host sheet; no new settings chrome. */
export function NotificationsToggle({ hostId }: { hostId: string }) {
  const { t } = useTranslation();
  const setEnabled = useCallback(
    (value: boolean) => {
      void notificationPreferences.setEnabled(hostId, value);
    },
    [hostId],
  );
  const state = useSyncExternalStore(
    notificationPreferences.subscribe,
    notificationPreferences.getState,
    notificationPreferences.getState,
  );
  useEffect(() => {
    if (isNative) void notificationPreferences.load().catch(() => undefined);
  }, []);
  if (!isNative) return null;
  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Text style={styles.label}>{t("pi.notifications.title")}</Text>
        <Switch
          value={state.enabled[hostId] === true}
          disabled={!state.loaded || state.busy}
          onValueChange={setEnabled}
          accessibilityLabel={t("pi.notifications.title")}
          testID="host-notifications"
        />
      </View>
      <Text style={styles.muted}>{t("pi.notifications.hint")}</Text>
      {state.denied ? (
        <View style={styles.denied}>
          <Text style={styles.muted}>{t("pi.notifications.denied")}</Text>
          <Button variant="ghost" onPress={openSettings} testID="notification-settings">
            {t("pi.notifications.settings")}
          </Button>
        </View>
      ) : null}
      {!state.denied && state.error ? (
        <Text style={styles.muted}>{t("pi.notifications.error")}</Text>
      ) : null}
    </View>
  );
}
function openSettings() {
  void Linking.openSettings().catch(() => undefined);
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[2], marginTop: theme.spacing[2] },
  row: {
    minHeight: MIN_TOUCH,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  label: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  denied: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
}));
