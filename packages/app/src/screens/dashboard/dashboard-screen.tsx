// Dashboard: forge's sessions page for one host. Needs input / Working / Completed, the counts
// line, pull to refresh, and a composer that starts a new session.

import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  SectionList,
  Text,
  View,
  type SectionListData,
  type SectionListRenderItem,
} from "react-native";
import Animated from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { Composer } from "@/components/pi/composer";
import { ConnectionBanner } from "@/components/pi/connection-banner";
import { failureText } from "@/components/pi/connection-text";
import { EmptyState } from "@/components/pi/empty-state";
import { MutedSpinner } from "@/components/pi/icons";
import { SessionRow } from "@/components/pi/session-row";
import { useToast } from "@/contexts/toast-context";
import type { SessionRow as SessionRowData, SessionSection, SessionsSnapshot } from "@/host/types";
import { useKeyboardShiftStyle } from "@/keyboard/shift";
import { useReportPlace } from "@/navigation/place-restorer";
import { friendlyHostError } from "@/screens/session/send-errors";
import {
  connectionStore,
  refreshSessions,
  sessionsStore,
  useHost,
  useHostConnection,
  useHostsLoaded,
  useSessionsEntry,
} from "@/stores/app";
import { startAndLocate } from "@/stores/start-session";
import { useAppActive, usePoller, useScreenFocused } from "@/stores/use-polling";
import { buildSections, countParts, type DashboardSection } from "./view-model";
import { MIN_TOUCH } from "@/styles/touch";

const POLL_MS = 2000;
const FILL = { flex: 1 };

const SECTION_LABEL: Record<SessionSection, string> = {
  needs: "pi.dashboard.needsInput",
  working: "pi.dashboard.working",
  completed: "pi.dashboard.completed",
};

export function openSession(hostId: string, sessionId: string) {
  router.push({ pathname: "/h/[hostId]/s/[sessionId]", params: { hostId, sessionId } });
}

function useStartSession(hostId: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const start = useCallback(
    async (prompt: string): Promise<boolean> => {
      const service = connectionStore.getState().getService(hostId);
      if (!service) {
        toast.error(t("pi.session.errors.connection"));
        return false;
      }
      setStarting(true);
      try {
        const found = await startAndLocate(service, { prompt });
        if (found.snapshot)
          sessionsStore.getState().setSnapshot(hostId, found.snapshot, Date.now());
        if (found.row) openSession(hostId, found.row.sessionId);
        else toast.show(t("pi.dashboard.startedNotFound"), { variant: "info" });
        return true;
      } catch (error) {
        const friendly = friendlyHostError(error);
        toast.error(friendly.detail ?? t(friendly.key));
        return false;
      } finally {
        setStarting(false);
      }
    },
    [hostId, t, toast],
  );
  return { start, starting };
}

interface SessionsListProps {
  hostId: string;
  hostLabel: string;
  snapshot: SessionsSnapshot;
  /** The counts line; scrolls with the list, as on forge's page. */
  summary: string;
}

function SessionsList({ hostId, hostLabel, snapshot, summary }: SessionsListProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const sections = useMemo(() => buildSections(snapshot.rows, expanded), [expanded, snapshot]);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (!connectionStore.getState().getService(hostId))
      await connectionStore.getState().connect(hostId);
    await refreshSessions(hostId);
    setRefreshing(false);
  }, [hostId]);
  const refresh = useCallback(() => void onRefresh(), [onRefresh]);
  const onPressRow = useCallback(
    (row: SessionRowData) => openSession(hostId, row.sessionId),
    [hostId],
  );
  const showMore = useCallback(() => setExpanded(true), []);
  const hostNow = snapshot.hostNow;

  const renderItem = useCallback<SectionListRenderItem<SessionRowData, DashboardSection>>(
    ({ item }) => <SessionRow row={item} hostNow={hostNow} onPress={onPressRow} />,
    [hostNow, onPressRow],
  );
  const renderSectionHeader = useCallback(
    ({ section }: { section: SectionListData<SessionRowData, DashboardSection> }) => (
      <Text style={styles.sectionLabel} accessibilityRole="header">
        {t(SECTION_LABEL[section.key])}
      </Text>
    ),
    [t],
  );
  const renderSectionFooter = useCallback(
    ({ section }: { section: SectionListData<SessionRowData, DashboardSection> }) =>
      section.hiddenCount > 0 ? (
        <Pressable
          onPress={showMore}
          style={styles.more}
          accessibilityRole="button"
          testID="dashboard-show-more"
        >
          <Text style={styles.moreText}>
            {t("pi.dashboard.showMore", { count: section.hiddenCount })}
          </Text>
        </Pressable>
      ) : null,
    [showMore, t],
  );
  const listEmpty = useMemo(
    () => (
      <EmptyState
        title={t("pi.dashboard.emptyTitle", { host: hostLabel })}
        body={t("pi.dashboard.emptyBody")}
        testID="dashboard-empty"
      />
    ),
    [hostLabel, t],
  );
  const listHeader = useMemo(
    () =>
      sections.length > 0 && summary ? (
        <Text style={styles.summary} testID="dashboard-summary">
          {summary}
        </Text>
      ) : null,
    [sections.length, summary],
  );
  return (
    <SectionList
      sections={sections}
      ListHeaderComponent={listHeader}
      keyExtractor={keyOf}
      renderItem={renderItem}
      renderSectionHeader={renderSectionHeader}
      renderSectionFooter={renderSectionFooter}
      stickySectionHeadersEnabled={false}
      ListEmptyComponent={listEmpty}
      contentContainerStyle={sections.length === 0 ? styles.emptyContent : styles.content}
      refreshing={refreshing}
      onRefresh={refresh}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      testID="dashboard-list"
    />
  );
}

export function DashboardScreen() {
  const { t } = useTranslation();
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const host = useHost(hostId);
  const hostsLoaded = useHostsLoaded();
  const connection = useHostConnection(hostId);
  const entry = useSessionsEntry(hostId);
  const focused = useScreenFocused();
  const appActive = useAppActive();
  const connected = connection.status === "connected";
  const { start, starting } = useStartSession(hostId);
  const { style: keyboardStyle } = useKeyboardShiftStyle({ mode: "padding" });
  useReportPlace({ kind: "dashboard", hostId }, focused);

  useEffect(() => {
    if (hostsLoaded && host) void connectionStore.getState().ensureConnected(hostId);
  }, [host, hostId, hostsLoaded]);

  const poll = useCallback(() => refreshSessions(hostId).then(() => undefined), [hostId]);
  usePoller(poll, POLL_MS, focused && appActive && connected);

  const snapshot = entry?.snapshot;
  const summary = useMemo(() => {
    if (!snapshot) return "";
    const parts = countParts(snapshot.counts).map((part) =>
      t(`pi.dashboard.count.${part.section}`, { count: part.count }),
    );
    return parts.length > 0 ? parts.join(" · ") : t("pi.dashboard.noSessions");
  }, [snapshot, t]);
  const retry = useCallback(() => {
    void connectionStore.getState().connect(hostId);
  }, [hostId]);

  let body;
  if (hostsLoaded && !host) {
    body = <EmptyState title={t("pi.dashboard.hostMissing")} testID="dashboard-host-missing" />;
  } else if (snapshot) {
    body = (
      <SessionsList
        hostId={hostId}
        hostLabel={host?.label ?? ""}
        snapshot={snapshot}
        summary={summary}
      />
    );
  } else if (connection.status === "failed") {
    body = (
      <EmptyState
        title={t("pi.connect.failed")}
        body={failureText(t, connection.failure)}
        actionLabel={t("pi.connect.retry")}
        onAction={retry}
        actionTestID="dashboard-retry"
        testID="dashboard-failed"
      />
    );
  } else {
    body = <SkeletonRows />;
  }

  const showBanner = snapshot !== undefined || connection.status === "reconnecting";
  return (
    <View style={styles.screen}>
      <BackHeader title={host?.label ?? t("pi.dashboard.title")} />
      <Animated.View style={[FILL, keyboardStyle]}>
        {showBanner ? (
          <ConnectionBanner hostId={hostId} connection={connection} announceEnabled={focused} />
        ) : null}
        <View style={FILL}>{body}</View>
        {host ? (
          <Composer
            placeholder={t("pi.dashboard.composerPlaceholder")}
            onSubmit={start}
            busy={starting}
            hint={starting ? t("pi.dashboard.starting") : undefined}
            testID="dashboard-composer"
            sendTestID="dashboard-send"
          />
        ) : null}
      </Animated.View>
    </View>
  );
}

const keyOf = (row: SessionRowData) => row.key;

const SKELETON_ROWS = ["a", "b", "c", "d"];

function SkeletonRows() {
  const { t } = useTranslation();
  return (
    <View
      style={styles.skeleton}
      testID="dashboard-loading"
      accessible
      accessibilityLabel={t("pi.dashboard.loading")}
    >
      {SKELETON_ROWS.map((key) => (
        <View key={key} style={styles.skeletonRow}>
          <View style={styles.skeletonGlyph} />
          <View style={styles.skeletonLines}>
            <View style={styles.skeletonTitle} />
            <View style={styles.skeletonMeta} />
          </View>
        </View>
      ))}
      <View style={styles.skeletonSpinner}>
        <MutedSpinner size="small" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  summary: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  content: { paddingBottom: theme.spacing[6] },
  emptyContent: { flexGrow: 1 },
  sectionLabel: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  more: {
    minHeight: MIN_TOUCH,
    justifyContent: "center",
    paddingLeft: theme.spacing[4] + 18 + theme.spacing[3],
  },
  moreText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  skeleton: { paddingTop: theme.spacing[6], gap: theme.spacing[1] },
  skeletonRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  skeletonGlyph: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  skeletonLines: { flex: 1, gap: theme.spacing[2] },
  skeletonTitle: {
    height: 14,
    width: "70%",
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
  },
  skeletonMeta: {
    height: 10,
    width: "40%",
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
  },
  skeletonSpinner: { paddingTop: theme.spacing[4], alignItems: "center" },
}));
