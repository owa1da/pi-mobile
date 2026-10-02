// Non-blocking strip under a header while a host is reconnecting or has failed.

import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { HostConnectionState } from "@/stores/connection-store";
import { connectionStore } from "@/stores/app";
import { failureText } from "./connection-text";
import { InlineBanner } from "./inline-banner";
import { MutedSpinner } from "./icons";
import { announce } from "./use-announce";
import { connectionAnnouncement, type ConnectionPhase } from "@/screens/session/announce";

const SPINNER = <MutedSpinner size="small" />;

interface ConnectionBannerProps {
  hostId: string;
  connection: HostConnectionState;
  /** Only the focused screen speaks; a screen under the stack stays quiet. */
  announceEnabled?: boolean;
}

function phaseOf(status: HostConnectionState["status"]): ConnectionPhase {
  if (status === "connected" || status === "reconnecting" || status === "failed") return status;
  return "other";
}

/** Speaks a drop, a failure and a recovery once each (polite; the strip itself never repeats). */
function useConnectionAnnouncements(connection: HostConnectionState, enabled: boolean) {
  const { t } = useTranslation();
  const previous = useRef<ConnectionPhase>(phaseOf(connection.status));
  const current = phaseOf(connection.status);
  useEffect(() => {
    const before = previous.current;
    previous.current = current;
    if (!enabled) return;
    const word = connectionAnnouncement(before, current);
    if (word === "reconnecting") announce(t("pi.connect.reconnecting"));
    else if (word === "failed")
      announce(`${t("pi.connect.failed")}. ${failureText(t, connection.failure)}`);
    else if (word === "restored") announce(t("pi.connect.restored"));
  }, [connection.failure, current, enabled, t]);
}

export function ConnectionBanner({
  hostId,
  connection,
  announceEnabled = true,
}: ConnectionBannerProps) {
  const { t } = useTranslation();
  useConnectionAnnouncements(connection, announceEnabled);
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
