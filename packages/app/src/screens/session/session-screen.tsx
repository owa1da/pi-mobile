// Session: title, then pi's state and model, then the chat (the transcript rendered with the kept
// Paseo components) and the composer.

import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import Animated from "react-native-reanimated";
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
import { ToolCallSheetProvider } from "@/components/tool-call-sheet";
import { useToast } from "@/contexts/toast-context";
import type { SessionRow } from "@/host/types";
import { useKeyboardShiftStyle } from "@/keyboard/shift";
import { useReportPlace } from "@/navigation/place-restorer";
import { restoredSessionOutcome } from "@/navigation/restore-place";
import { rowGlyph, shortModel } from "@/screens/dashboard/view-model";
import {
  connectionStore,
  refreshSessions,
  useHostConnection,
  useHostsLoaded,
  useSessionsEntry,
} from "@/stores/app";
import { findRow, type SessionsEntry } from "@/stores/sessions-store";
import type { HostConnectionState } from "@/stores/connection-store";
import { useAppActive, usePoller, useScreenFocused } from "@/stores/use-polling";
import { useAnnounceOnChange, announce } from "@/components/pi/use-announce";
import { latestReply, nextReplyAnnouncement, previewText } from "./announce";
import { subBarStatus, waitingBannerVisible } from "./chrome";
import { friendlyHostError, type FriendlyError } from "./send-errors";
import { useChatFeed } from "./use-chat-feed";
import { AnswerDock, openIdsOf } from "./answer-dock";
import { friendlyRemote, useAnswers, useNotice } from "./use-answers";
import { useRemoteChannel } from "./use-remote-channel";
import { matchCommand, refusalOutcome } from "@/remote/menu";
import { isRemoteError } from "@/remote/errors";

const POLL_MS = 2000;
const FILL = { flex: 1 };

function backToSessions() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

/**
 * A session reopened after a font-scale reload: decided once, when the host's first snapshot
 * arrives. If the session no longer exists, go back to its dashboard (pushed under it by
 * PlaceRestorer) instead of showing "not found". Returns true while leaving.
 */
function useLeaveIfRestoredSessionGone(
  restored: boolean,
  hasRow: boolean,
  hasSnapshot: boolean,
): boolean {
  const decided = useRef(!restored);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (decided.current) return;
    const outcome = restoredSessionOutcome(hasRow, hasSnapshot);
    if (outcome === "wait") return;
    decided.current = true;
    if (outcome === "leave") {
      setLeaving(true);
      backToSessions();
    }
  }, [hasRow, hasSnapshot]);
  return leaving;
}

interface SessionParams {
  hostId: string;
  sessionId: string;
  /** Set by PlaceRestorer after a font-scale reload. */
  restored?: string;
}

/** The session's row, reported as the user's place while focused. */
function useSessionPlace(
  params: SessionParams,
  entry: SessionsEntry | undefined,
  focused: boolean,
) {
  const { hostId, sessionId } = params;
  const row = findRow(entry, sessionId);
  useReportPlace({ kind: "session", hostId, sessionId }, focused);
  const leaving = useLeaveIfRestoredSessionGone(
    params.restored === "1",
    row !== undefined,
    Boolean(entry?.snapshot),
  );
  return { row, leaving };
}

export function SessionScreen() {
  const { t } = useTranslation();
  // Pick gives the mapped (index-compatible) shape expo-router's params constraint needs.
  const params = useLocalSearchParams<Pick<SessionParams, keyof SessionParams>>();
  const { hostId } = params;
  const hostsLoaded = useHostsLoaded();
  const connection = useHostConnection(hostId);
  const entry = useSessionsEntry(hostId);
  const focused = useScreenFocused();
  const appActive = useAppActive();
  const connected = connection.status === "connected";
  const { row, leaving } = useSessionPlace(params, entry, focused);
  // An optimistic send in flight (until the next listing shows pi's state): the sub-bar says so.
  const [sendPending, setSendPending] = useState(false);
  const seen = useRef(false);
  if (row) seen.current = true;
  const { style: keyboardStyle } = useKeyboardShiftStyle({ mode: "padding" });

  useEffect(() => {
    if (hostsLoaded) void connectionStore.getState().ensureConnected(hostId);
  }, [hostId, hostsLoaded]);
  const poll = useCallback(() => refreshSessions(hostId).then(() => undefined), [hostId]);
  usePoller(poll, POLL_MS, focused && appActive && connected);

  const retry = useCallback(() => {
    void connectionStore.getState().connect(hostId);
  }, [hostId]);

  let body;
  if (row) {
    body = (
      <>
        <SessionSubBar row={row} connection={connection} sending={sendPending} />
        <ConnectionBanner hostId={hostId} connection={connection} announceEnabled={focused} />
        <ChatPane
          hostId={hostId}
          row={row}
          entry={entry}
          active={focused && appActive}
          onPendingChange={setSendPending}
        />
      </>
    );
  } else if (entry?.snapshot && !leaving) {
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
      <View
        style={styles.center}
        accessible
        accessibilityLabel={t("pi.session.loading")}
        testID="session-loading"
      >
        <MutedSpinner size="small" />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <BackHeader title={row?.title || t("pi.session.title")} />
      <Animated.View style={[FILL, keyboardStyle]}>{body}</Animated.View>
    </View>
  );
}

function SessionSubBar({
  row,
  connection,
  sending,
}: {
  row: SessionRow;
  connection: HostConnectionState;
  sending: boolean;
}) {
  const { t } = useTranslation();
  const model = shortModel(row.model);
  // While the connection is not live the last-known state is stale: name the connection instead,
  // or (banner up) say nothing and keep only the session's identity, dimmed.
  const status = subBarStatus(connection.status, row.state, sending);
  const quiet = status.kind === "quiet";
  const word = quiet ? null : t(status.key);
  const meta = [word, model].filter(Boolean).join(" · ");
  let glyph = rowGlyph(row);
  if (status.kind === "pending") glyph = "working";
  else if (status.kind !== "state") glyph = "gone";
  return (
    <View style={styles.subBar}>
      <View style={styles.subBarMeta}>
        <SessionGlyph kind={glyph} />
        <Text
          style={[styles.subBarText, quiet && styles.subBarQuiet]}
          numberOfLines={1}
          testID="session-state"
        >
          {meta}
        </Text>
      </View>
    </View>
  );
}

interface ChatPaneProps {
  hostId: string;
  row: SessionRow;
  entry: SessionsEntry | undefined;
  active: boolean;
  onPendingChange: (pending: boolean) => void;
}

function ChatPane(props: ChatPaneProps) {
  const toast = useToast();
  return (
    <AssistantFileLinkResolverProvider toast={toast}>
      <ToolCallSheetProvider>
        <ChatPaneBody {...props} />
      </ToolCallSheetProvider>
    </AssistantFileLinkResolverProvider>
  );
}

function composerPlaceholderKey(row: SessionRow): string {
  if (!row.live) return "pi.session.placeholderClosed";
  return row.state === "working" ? "pi.session.placeholderWorking" : "pi.session.placeholder";
}

function ChatPaneBody({ hostId, row, entry, active, onPendingChange }: ChatPaneProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const feed = useChatFeed(hostId, row, active);
  const channel = useRemoteChannel(hostId, row, entry, active);
  const { notice, show: showNotice, dismiss: dismissNotice } = useNotice();
  const openIds = useMemo(() => openIdsOf(channel), [channel]);
  const answers = useAnswers(channel, openIds, t, showNotice);
  useReplyAnnouncement(feed.rows, row.state === "working", active);
  useAnnounceOnChange(
    row.state === "waiting"
      ? t("pi.session.askingAnnounce", { question: row.asking ?? row.detail ?? "" })
      : null,
    active,
  );
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<FriendlyError | null>(null);
  const sendingRef = useRef(false);

  /**
   * A `/` line forge lists: run it through the remote channel (as typed in pi's editor). "paste"
   * when forge says it starts a turn (a prompt template): the caller sends it as a message.
   */
  const runCommand = useCallback(
    async (line: string, name: string): Promise<boolean | "paste"> => {
      if (sendingRef.current) return false;
      sendingRef.current = true;
      setSending(true);
      setSendError(null);
      try {
        await channel.send("command.run", { line });
        feed.boost();
        return true;
      } catch (error) {
        if (isRemoteError(error, "refused")) {
          const outcome = refusalOutcome(name, error.detail);
          if (outcome.kind === "paste") return "paste";
          if (outcome.kind === "notice") {
            showNotice({ text: t(outcome.key, outcome.params), testID: outcome.testID });
            return true;
          }
        }
        setSendError(friendlyRemote(error));
        return false;
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [channel, feed, showNotice, t],
  );

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const command = channel.available ? matchCommand(text, channel.state?.commands) : undefined;
      if (command) {
        const ran = await runCommand(text, command.name);
        if (ran !== "paste") return ran;
      }
      // One send at a time: a pending send (maybe a resume) is never doubled by a second tap.
      if (sendingRef.current) return false;
      const service = connectionStore.getState().getService(hostId);
      if (!service) {
        setSendError({ key: "pi.session.errors.connection" });
        return false;
      }
      setSendError(null);
      const pendingId = feed.addPending(text);
      sendingRef.current = true;
      setSending(true);
      onPendingChange(true);
      const settle = () => {
        onPendingChange(false);
        return undefined;
      };
      try {
        await service.sendPrompt(row, text);
        feed.boost();
        // "Sending…" holds until the listing shows pi's new state (Working, or a quick reply).
        void refreshSessions(hostId).then(settle, settle);
        return true;
      } catch (error) {
        settle();
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
    [channel.available, channel.state?.commands, feed, hostId, onPendingChange, row, runCommand],
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
        {waitingBannerVisible(row.state, channel) ? (
          <InlineBanner
            tone="warning"
            leading={askingGlyph}
            title={t("pi.session.asking")}
            message={row.asking ?? row.detail ?? ""}
            testID="chat-waiting-banner"
          />
        ) : null}
        {notice ? (
          <InlineBanner
            tone="muted"
            message={notice.text}
            dismissLabel={t("pi.session.dismiss")}
            onDismiss={dismissNotice}
            testID={notice.testID}
          />
        ) : null}
        {sendError ? (
          <InlineBanner
            tone="danger"
            message={errorMessage}
            dismissLabel={t("pi.session.dismiss")}
            onDismiss={dismissError}
            testID="chat-send-error"
          />
        ) : null}
      </View>
      <AnswerDock channel={channel} answers={answers}>
        <Composer
          commands={channel.available ? channel.state?.commands : undefined}
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
      </AnswerDock>
    </View>
  );
}

/** Speaks pi's final reply once when it lands (never the old one on open, never mid-turn steps). */
function useReplyAnnouncement(
  rows: Parameters<typeof latestReply>[0],
  working: boolean,
  active: boolean,
) {
  const { t } = useTranslation();
  const baseline = useRef<string | null | undefined>(undefined);
  const latest = latestReply(rows);
  const latestKey = latest?.key;
  const latestText = latest?.text;
  useEffect(() => {
    const ref = latestKey !== undefined ? { key: latestKey, text: latestText ?? "" } : null;
    const next = nextReplyAnnouncement(baseline.current, ref, working);
    baseline.current = next.baseline;
    if (next.announce && active)
      announce(t("pi.session.replied", { preview: previewText(next.announce.text) }));
  }, [active, latestKey, latestText, t, working]);
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
  subBarQuiet: { color: theme.colors.foregroundExtraMuted },
  banners: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
}));
