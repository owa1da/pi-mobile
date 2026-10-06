// Dashboard: forge's sessions page for one host. Needs input / Working / Completed, the counts
// line, pull to refresh, and a composer that starts a new session.

import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { cachedCommands, subscribeCommands } from "@/screens/session/command-cache";
import {
  latestCommands,
  refreshCommandCatalog,
  CATALOG_POLL_MS,
} from "@/stores/command-catalog-store";
import type { RemoteCommand } from "@/remote/types";
import { dashboardCommands } from "@/remote/menu";
import { isHostPanel } from "@/remote/panel-snapshot";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  SectionList,
  Text,
  View,
  type SectionListData,
  type SectionListRenderItem,
  type ViewToken,
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
import { useNow } from "@/hooks/use-now";
import { useKeyboardShiftStyle } from "@/keyboard/shift";
import { useReportPlace } from "@/navigation/place-restorer";
import { friendlyHostError } from "@/screens/session/send-errors";
import {
  commandCatalogStore,
  connectionStore,
  refreshSessions,
  sessionsStore,
  useHost,
  useHostConnection,
  useHostsLoaded,
  useSessionsEntry,
} from "@/stores/app";
import { startDashboardSession } from "@/stores/start-session";
import { useAppActive, usePoller, useScreenFocused } from "@/stores/use-polling";
import {
  buildSections,
  countParts,
  formatAge,
  steadyHostNow,
  type DashboardSection,
} from "./view-model";
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
  const startingRef = useRef(false);
  const start = useCallback(
    async (prompt: string): Promise<boolean> => {
      if (startingRef.current) return false;
      const service = connectionStore.getState().getService(hostId);
      if (!service) {
        toast.error(t("pi.session.errors.connection"));
        return false;
      }
      startingRef.current = true;
      setStarting(true);
      try {
        const found = await startDashboardSession(
          {
            startSession: (input) => service.startSession(input),
            listSessions: async () => {
              const generation = sessionsStore.getState().beginListing(hostId);
              const snapshot = await service.listSessions();
              sessionsStore.getState().setSnapshot(hostId, snapshot, Date.now(), generation);
              return snapshot;
            },
          },
          hostId,
          prompt,
        );
        if (found.row) openSession(hostId, found.row.sessionId);
        else toast.show(t("pi.dashboard.startedNotFound"), { variant: "info" });
        return true;
      } catch (error) {
        const friendly = friendlyHostError(error);
        toast.error(friendly.detail ?? t(friendly.key));
        return false;
      } finally {
        startingRef.current = false;
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
  fetchedAt: number;
  active: boolean;
  /** The counts line; scrolls with the list, as on forge's page. */
  summary: string;
}

function SessionsList({
  hostId,
  hostLabel,
  snapshot,
  fetchedAt,
  active,
  summary,
}: SessionsListProps) {
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
  const [visibleKeys, setVisibleKeys] = useState<Set<string> | null>(null);
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<SessionRowData>[] }) => {
      setVisibleKeys(new Set(viewableItems.map(({ item }) => item.key)));
    },
    [],
  );
  const listedRows = sections.flatMap((section) => section.data);
  const visibleRows = listedRows.filter((row) => visibleKeys === null || visibleKeys.has(row.key));
  const ticking = active && visibleRows.length > 0;
  const slowNow = useNow(15_000, ticking);
  const slowHostNow = snapshot.hostNow + (slowNow - fetchedAt) / 1000;
  const young = visibleRows.some((row) => slowHostNow - row.since / 1000 < 60);
  const secondNow = useNow(1000, ticking && young);
  const now = young ? secondNow : slowNow;
  const hostNow = steadyHostNow(hostId, snapshot.hostNow + (now - fetchedAt) / 1000);

  const renderItem = useCallback<SectionListRenderItem<SessionRowData, DashboardSection>>(
    ({ item }) => (
      <SessionRow row={item} age={formatAge(item.since, hostNow)} onPress={onPressRow} />
    ),
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
      extraData={hostNow}
      onViewableItemsChanged={onViewableItemsChanged}
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

  const polling = focused && appActive && connected;
  const poll = useCallback(() => refreshSessions(hostId).then(() => undefined), [hostId]);
  usePoller(poll, POLL_MS, polling);
  const catalogPoll = useCallback(
    () =>
      refreshCommandCatalog(
        commandCatalogStore,
        hostId,
        connectionStore.getState().getService(hostId),
      ),
    [hostId],
  );
  usePoller(catalogPoll, CATALOG_POLL_MS, polling);
  const getCommands = useCallback(() => cachedCommands(hostId), [hostId]);
  const remembered = useSyncExternalStore(subscribeCommands, getCommands, getCommands);
  const commands = useStore(commandCatalogStore, (state) =>
    latestCommands(state, hostId, remembered),
  );
  // A successful host probe requires Forge. Keep the panels discoverable even with no catalog.
  const menuCommands = useMemo(
    () => dashboardCommands(commands, Boolean(connection.env) || connected),
    [commands, connection.env, connected],
  );
  const pickCommand = useCallback(
    (command: RemoteCommand) => {
      if (isHostPanel(command.name)) {
        router.push({
          pathname: "/h/[hostId]/panel/[name]",
          params: { hostId, name: command.name },
        });
        return true;
      }
      return start(`/${command.name}`);
    },
    [hostId, start],
  );
  const submit = useCallback(
    async (text: string) => {
      const panel = menuCommands.find(
        (command) => isHostPanel(command.name) && text.trim() === `/${command.name}`,
      );
      return panel ? pickCommand(panel) : start(text);
    },
    [menuCommands, pickCommand, start],
  );

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
        fetchedAt={entry?.fetchedAt ?? Date.now()}
        active={focused && appActive}
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
            commands={menuCommands}
            onPickNative={pickCommand}
            placeholder={t("pi.dashboard.composerPlaceholder")}
            onSubmit={submit}
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
