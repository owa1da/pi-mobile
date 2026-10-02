// Session: title, state and model, then Chat | Terminal. Chat renders the transcript with the kept
// Paseo components; Terminal attaches the real tmux pane, so everything pi can do stays reachable.

import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackHandler, Text, View, useWindowDimensions } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { AssistantFileLinkResolverProvider } from "@/assistant-file-links";
import { BackHeader } from "@/components/headers/back-header";
import { ChatView } from "@/components/pi/chat-view";
import { Composer } from "@/components/pi/composer";
import { ConnectionBanner } from "@/components/pi/connection-banner";
import { failureText } from "@/components/pi/connection-text";
import { EmptyState } from "@/components/pi/empty-state";
import { MutedSpinner } from "@/components/pi/icons";
import { InlineBanner } from "@/components/pi/inline-banner";
import { SessionGlyph } from "@/components/pi/session-glyph";
import { TerminalView } from "@/components/pi/terminal-view";
import { ToolCallSheetProvider } from "@/components/tool-call-sheet";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useToast } from "@/contexts/toast-context";
import type { SessionRow } from "@/host/types";
import { useKeyboardShiftStyle } from "@/keyboard/shift";
import { presentRow, shortModel } from "@/screens/dashboard/view-model";
import {
  connectionStore,
  refreshSessions,
  useHostConnection,
  useHostsLoaded,
  useSessionsEntry,
} from "@/stores/app";
import { findRow } from "@/stores/sessions-store";
import type { HostConnectionState } from "@/stores/connection-store";
import { useAppActive, usePoller, useScreenFocused } from "@/stores/use-polling";
import { useIsHandheld } from "@/utils/use-handheld";
import { setImmersive } from "../../../modules/pi-system-bars";
import { shouldCollapseTerminalChrome, subBarStatus } from "./chrome";
import { friendlyHostError, type FriendlyError } from "./send-errors";
import { useChatFeed } from "./use-chat-feed";

type Tab = "chat" | "terminal";

const POLL_MS = 2000;
const FILL = { flex: 1 };
const HIDDEN = { display: "none" as const };

function backToSessions() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

/**
 * Handheld landscape on the Terminal tab: header, sub-bar and system bars give way to terminal
 * rows. System back while collapsed returns to Chat (restoring the chrome) instead of leaving.
 */
function useTerminalChromeCollapse(
  hasRow: boolean,
  tab: Tab,
  setTab: (tab: Tab) => void,
  focused: boolean,
) {
  const handheld = useIsHandheld();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const collapsed = hasRow && shouldCollapseTerminalChrome({ tab, handheld, width, height });

  useEffect(() => {
    if (!collapsed || !focused) return undefined;
    setImmersive(true);
    return () => setImmersive(false);
  }, [collapsed, focused]);

  useEffect(() => {
    if (!collapsed) return undefined;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setTab("chat");
      return true;
    });
    return () => sub.remove();
  }, [collapsed, setTab]);

  const collapsedStyle = useMemo(
    () => (collapsed ? { paddingTop: insets.top } : undefined),
    [collapsed, insets.top],
  );
  return { collapsed, collapsedStyle };
}

export function SessionScreen() {
  const { t } = useTranslation();
  const { hostId, sessionId } = useLocalSearchParams<{ hostId: string; sessionId: string }>();
  const hostsLoaded = useHostsLoaded();
  const connection = useHostConnection(hostId);
  const entry = useSessionsEntry(hostId);
  const focused = useScreenFocused();
  const appActive = useAppActive();
  const connected = connection.status === "connected";
  const [tab, setTab] = useState<Tab>("chat");
  const row = findRow(entry, sessionId);
  const seen = useRef(false);
  if (row) seen.current = true;
  const { style: keyboardStyle } = useKeyboardShiftStyle({ mode: "padding" });
  const { collapsed, collapsedStyle } = useTerminalChromeCollapse(
    row !== undefined,
    tab,
    setTab,
    focused,
  );

  useEffect(() => {
    if (hostsLoaded) void connectionStore.getState().ensureConnected(hostId);
  }, [hostId, hostsLoaded]);
  const poll = useCallback(() => refreshSessions(hostId).then(() => undefined), [hostId]);
  usePoller(poll, POLL_MS, focused && appActive && connected);

  const retry = useCallback(() => {
    void connectionStore.getState().connect(hostId);
  }, [hostId]);
  const openTerminal = useCallback(() => setTab("terminal"), []);
  const toChat = useCallback(() => setTab("chat"), []);

  let body;
  if (row) {
    body = (
      <>
        {collapsed ? null : (
          <SessionSubBar row={row} tab={tab} onTab={setTab} connection={connection} />
        )}
        <ConnectionBanner hostId={hostId} connection={connection} />
        <View style={tab === "chat" ? FILL : HIDDEN}>
          <ChatPane
            hostId={hostId}
            row={row}
            active={tab === "chat" && focused && appActive}
            onOpenTerminal={openTerminal}
          />
        </View>
        {tab === "terminal" ? (
          <TerminalPane
            hostId={hostId}
            row={row}
            connected={connected}
            onToChat={collapsed ? toChat : undefined}
          />
        ) : null}
      </>
    );
  } else if (entry?.snapshot) {
    body = (
      <EmptyState
        title={seen.current ? t("pi.session.goneTitle") : t("pi.session.notFoundTitle")}
        body={seen.current ? t("pi.session.goneBody") : t("pi.session.notFoundBody")}
        actionLabel={t("pi.session.backToSessions")}
        onAction={backToSessions}
        actionTestID="session-back"
        testID="session-not-found"
      />
    );
  } else if (connection.status === "failed") {
    body = (
      <EmptyState
        title={t("pi.connect.failed")}
        body={failureText(t, connection.failure)}
        actionLabel={t("pi.connect.retry")}
        onAction={retry}
        actionTestID="session-retry"
      />
    );
  } else {
    body = (
      <View style={styles.center}>
        <MutedSpinner size="small" />
      </View>
    );
  }

  return (
    <View style={[styles.screen, collapsedStyle]}>
      {collapsed ? null : <BackHeader title={row?.title || t("pi.session.title")} />}
      <Animated.View style={[FILL, keyboardStyle]}>{body}</Animated.View>
    </View>
  );
}

function SessionSubBar({
  row,
  tab,
  onTab,
  connection,
}: {
  row: SessionRow;
  tab: Tab;
  onTab: (tab: Tab) => void;
  connection: HostConnectionState;
}) {
  const { t } = useTranslation();
  const options = useMemo<SegmentedControlOption<Tab>[]>(
    () => [
      { value: "chat", label: t("pi.session.chat"), testID: "session-tab-chat" },
      { value: "terminal", label: t("pi.session.terminal"), testID: "session-tab-terminal" },
    ],
    [t],
  );
  const model = shortModel(row.model);
  // While the connection is not live the last-known state is stale: name the connection instead.
  const status = subBarStatus(connection.status, row.state);
  const meta = [t(status.key), model].filter(Boolean).join(" · ");
  return (
    <View style={styles.subBar}>
      <View style={styles.subBarMeta}>
        <SessionGlyph kind={status.kind === "state" ? presentRow(row).glyph : "gone"} />
        <Text style={styles.subBarText} numberOfLines={1} testID="session-state">
          {meta}
        </Text>
      </View>
      <SegmentedControl
        options={options}
        value={tab}
        onValueChange={onTab}
        size="sm"
        testID="session-tabs"
      />
    </View>
  );
}

function ChatPane({
  hostId,
  row,
  active,
  onOpenTerminal,
}: {
  hostId: string;
  row: SessionRow;
  active: boolean;
  onOpenTerminal: () => void;
}) {
  const toast = useToast();
  return (
    <AssistantFileLinkResolverProvider toast={toast}>
      <ToolCallSheetProvider>
        <ChatPaneBody hostId={hostId} row={row} active={active} onOpenTerminal={onOpenTerminal} />
      </ToolCallSheetProvider>
    </AssistantFileLinkResolverProvider>
  );
}

function composerPlaceholderKey(row: SessionRow): string {
  if (!row.live) return "pi.session.placeholderClosed";
  return row.state === "working" ? "pi.session.placeholderWorking" : "pi.session.placeholder";
}

function ChatPaneBody({
  hostId,
  row,
  active,
  onOpenTerminal,
}: {
  hostId: string;
  row: SessionRow;
  active: boolean;
  onOpenTerminal: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const feed = useChatFeed(hostId, row, active);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<FriendlyError | null>(null);
  const sendingRef = useRef(false);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      // One send at a time: a pending send (maybe a resume) is never doubled by a second tap.
      if (sendingRef.current) return false;
      const service = connectionStore.getState().getService(hostId);
      if (!service) {
        setSendError({ key: "pi.session.errors.connection", terminal: false });
        return false;
      }
      setSendError(null);
      const pendingId = feed.addPending(text);
      sendingRef.current = true;
      setSending(true);
      try {
        await service.sendPrompt(row, text);
        feed.boost();
        void refreshSessions(hostId);
        return true;
      } catch (error) {
        // Never re-echo or resend: when the outcome is unknown, the chat refresh shows whether it
        // arrived; the text goes back into the composer only for the user to decide.
        feed.removePending(pendingId);
        const friendly = friendlyHostError(error);
        setSendError(friendly);
        if (friendly.outcomeUnknown) {
          feed.boost();
          void refreshSessions(hostId);
        }
        connectionStore.getState().reportFailure(hostId, error);
        return false;
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [feed, hostId, row],
  );

  const stop = useCallback(() => {
    const service = connectionStore.getState().getService(hostId);
    if (!service) return;
    service.abort(row).then(
      () => {
        feed.boost();
        return undefined;
      },
      (error: unknown) => {
        const friendly = friendlyHostError(error);
        toast.error(friendly.detail ?? t(friendly.key));
      },
    );
  }, [feed, hostId, row, t, toast]);

  const dismissError = useCallback(() => setSendError(null), []);
  const askingGlyph = useMemo(() => <SessionGlyph kind="needs" />, []);
  const errorMessage = sendError
    ? [t(sendError.key), sendError.detail].filter(Boolean).join(" ")
    : "";

  return (
    <View style={FILL}>
      {feed.hasFile ? (
        <ChatView rows={feed.rows} truncated={feed.truncated} loading={feed.loading} />
      ) : (
        <EmptyState title={t("pi.session.noFile")} testID="chat-no-file" />
      )}
      <View style={styles.banners}>
        {row.state === "waiting" ? (
          <InlineBanner
            tone="warning"
            leading={askingGlyph}
            title={t("pi.session.asking")}
            message={row.asking ?? row.detail ?? ""}
            actionLabel={t("pi.session.answerInTerminal")}
            onAction={onOpenTerminal}
            actionTestID="chat-answer-in-terminal"
            testID="chat-waiting-banner"
          />
        ) : null}
        {sendError ? (
          <InlineBanner
            tone="danger"
            message={errorMessage}
            actionLabel={sendError.terminal ? t("pi.session.openTerminal") : undefined}
            onAction={sendError.terminal ? onOpenTerminal : undefined}
            actionTestID="chat-error-open-terminal"
            dismissLabel={t("pi.session.dismiss")}
            onDismiss={dismissError}
            testID="chat-send-error"
          />
        ) : null}
      </View>
      <Composer
        placeholder={t(composerPlaceholderKey(row))}
        onSubmit={send}
        busy={sending}
        canStop={row.live && row.state === "working"}
        onStop={stop}
        hint={row.live ? undefined : t("pi.session.closedHint")}
        testID="chat-composer"
        sendTestID="chat-send"
        stopTestID="chat-stop"
      />
    </View>
  );
}

function TerminalPane({
  hostId,
  row,
  connected,
  onToChat,
}: {
  hostId: string;
  row: SessionRow;
  connected: boolean;
  onToChat?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [attempt, setAttempt] = useState(0);
  const [resuming, setResuming] = useState(false);
  const resumingRef = useRef(false);
  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);
  const resume = useCallback(async () => {
    if (resumingRef.current) return;
    const service = connectionStore.getState().getService(hostId);
    if (!service) return;
    resumingRef.current = true;
    setResuming(true);
    try {
      await service.resumeSession(row);
      await refreshSessions(hostId);
    } catch (error) {
      const friendly = friendlyHostError(error);
      toast.error(friendly.detail ?? t(friendly.key));
      if (friendly.outcomeUnknown) void refreshSessions(hostId);
    } finally {
      resumingRef.current = false;
      setResuming(false);
    }
  }, [hostId, row, t, toast]);
  const onResume = useCallback(() => void resume(), [resume]);

  if (!row.live || !row.tmux) {
    return (
      <EmptyState
        title={t("pi.session.closedTitle")}
        body={t("pi.session.closedBody")}
        actionLabel={t("pi.session.resume")}
        onAction={onResume}
        actionLoading={resuming}
        actionTestID="terminal-resume"
        testID="terminal-closed"
      />
    );
  }
  if (!connected) {
    return (
      <View style={styles.center}>
        <MutedSpinner size="small" />
      </View>
    );
  }
  return (
    <View style={FILL}>
      <TerminalView
        key={`${row.tmux.pane}:${attempt}`}
        hostId={hostId}
        row={row}
        onReconnect={reconnect}
        onToChat={onToChat}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  subBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  subBarMeta: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  subBarText: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  banners: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
}));
