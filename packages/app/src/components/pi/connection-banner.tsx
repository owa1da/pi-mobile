// Non-blocking strip under a header while a host is reconnecting or has failed.

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { HostConnectionState } from "@/stores/connection-store";
import { connectionStore } from "@/stores/app";
import { failureText } from "./connection-text";
import { InlineBanner } from "./inline-banner";
import { MutedSpinner } from "./icons";

const SPINNER = <MutedSpinner size="small" />;

interface ConnectionBannerProps {
  hostId: string;
  connection: HostConnectionState;
}

export function ConnectionBanner({ hostId, connection }: ConnectionBannerProps) {
  const { t } = useTranslation();
  const retry = useCallback(() => {
    void connectionStore.getState().connect(hostId);
  }, [hostId]);
  if (connection.status === "reconnecting") {
    return (
      <View style={styles.wrap}>
        <InlineBanner
          tone="muted"
          leading={SPINNER}
          message={t("pi.connect.reconnecting")}
          actionLabel={t("pi.connect.retry")}
          onAction={retry}
          actionTestID="connection-retry"
          testID="connection-banner"
          messageLines={1}
        />
      </View>
    );
  }
  if (connection.status !== "failed") return null;
  return (
    <View style={styles.wrap}>
      <InlineBanner
        tone="danger"
        title={t("pi.connect.failed")}
        message={failureText(t, connection.failure)}
        actionLabel={t("pi.connect.retry")}
        onAction={retry}
        actionTestID="connection-retry"
        testID="connection-banner"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[2] },
}));
