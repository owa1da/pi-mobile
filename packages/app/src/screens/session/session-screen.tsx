// Session: the title, the chat (the transcript rendered with the kept Paseo components), the
// composer, and forge's status line right under it (status-line.md: ONE line under the input).

import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type LayoutChangeEvent } from "react-native";
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
import { NoteRow } from "@/components/pi/note-row";
import { SessionGlyph } from "@/components/pi/session-glyph";
import { ToolCallSheetProvider } from "@/components/tool-call-sheet";
import { useToast } from "@/contexts/toast-context";
import type { SessionRow } from "@/host/types";
import { useKeyboardShiftStyle } from "@/keyboard/shift";
import { useReportPlace } from "@/navigation/place-restorer";
import { restoredSessionOutcome } from "@/navigation/restore-place";
import { shortModel } from "@/screens/dashboard/view-model";
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
import { hostNow } from "@/remote/for-service";
import { useAnnounceOnChange, announce } from "@/components/pi/use-announce";
import { latestReply, nextReplyAnnouncement, previewText } from "./announce";
import {
  fitLine,
  footerDimmed,
  inputHeld,
  waitingBannerVisible,
  workingClock,
  workingRowVisible,
  type LineKind,
} from "./chrome";
import { friendlyHostError, type FriendlyError } from "./send-errors";
import { useChatFeed } from "./use-chat-feed";
import { AnswerDock, openIdsOf } from "./answer-dock";
import { friendlyRemote, useAnswers, useNotice } from "./use-answers";
import { useRemoteChannel } from "./use-remote-channel";
import {
  matchCommand,
  NATIVE_COMMANDS,
  nativeTarget,
  refusalOutcome,
  SHEET_TOOLS,
  type NativeTool,
} from "@/remote/menu";
import { isRemoteError } from "@/remote/errors";
import type { RemoteCommand, RemoteFooter } from "@/remote/types";
import { footerParts, type FooterPart } from "@/remote/views";
import { takeHandBack } from "@/screens/forge/draft-store";
import { openForge, type ForgeTool } from "@/screens/forge/parts";
import { SessionSheets, type OpenSheet, type SheetTool } from "@/screens/forge/sheets";
import type { RemoteChannel } from "./use-remote-channel";

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
  const seen = useRef(false);
  if (row) seen.current = true;
  const { style: keyboardStyle } = useKeyboardShiftStyle({ mode: "padding" });
  const following = useFollowPid(hostId, params.sessionId, entry);

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
      <SessionBody
        hostId={hostId}
        row={row}
        entry={entry}
        connection={connection}
        focused={focused}
        active={focused && appActive}
        onReplaced={following.follow}
      />
    );
  } else if (entry?.snapshot && !leaving && !following.active) {
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

/**
 * /clear and /branch start a new session inside the same pi process: once the listing shows that
 * pid under another session id, the screen moves to it (replace, so Back still goes to the list).
 */
function useFollowPid(hostId: string, sessionId: string, entry: SessionsEntry | undefined) {
  const [pid, setPid] = useState<number | null>(null);
  useEffect(() => {
    if (pid === null) return undefined;
    const next = entry?.snapshot?.rows.find(
      (r) => r.pid === pid && r.live && r.sessionId !== sessionId,
    );
    if (next) {
      setPid(null);
      router.replace({
        pathname: "/h/[hostId]/s/[sessionId]",
        params: { hostId, sessionId: next.sessionId },
      });
      return undefined;
    }
    const timer = setTimeout(() => setPid(null), 15_000);
    return () => clearTimeout(timer);
  }, [entry, hostId, pid, sessionId]);
  const follow = useCallback(
    (next: number) => {
      if (next > 0) {
        setPid(next);
        void refreshSessions(hostId);
      }
    },
    [hostId],
  );
  return { active: pid !== null, follow };
}

interface SessionBodyProps {
  hostId: string;
  row: SessionRow;
  entry: SessionsEntry | undefined;
  connection: HostConnectionState;
  focused: boolean;
  active: boolean;
  onReplaced: (pid: number) => void;
}

/** The session with its remote channel: the chat, the composer with forge's line under it, the sheets. */
function SessionBody(props: SessionBodyProps) {
  const { hostId, row, entry, connection, focused, active } = props;
  const channel = useRemoteChannel(hostId, row, entry, active);
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const openNative = useCallback(
    (tool: NativeTool, arg: string) => {
      if (SHEET_TOOLS.has(tool)) setSheet({ kind: tool as SheetTool, arg });
      else openForge(hostId, row.sessionId, tool as ForgeTool, arg ? { arg } : {});
    },
    [hostId, row.sessionId],
  );
  const closeSheet = useCallback(() => setSheet(null), []);
  const held = channel.available && inputHeld(channel.state);
  return (
    <>
      <ConnectionBanner hostId={hostId} connection={connection} announceEnabled={focused} />
      <ChatPane
        hostId={hostId}
        row={row}
        entry={entry}
        active={active}
        connection={connection}
        held={held}
        channel={channel}
        openNative={openNative}
      />
      <SessionSheets
        hostId={hostId}
        row={row}
        channel={channel}
        sheet={sheet}
        onClose={closeSheet}
        onReplaced={props.onReplaced}
      />
    </>
  );
}

/**
 * The footer's parts: forge's status line when it publishes one (exactly the desktop's facts, no
 * state word), else the row's model. Each part gets a stable key (its text, numbered on repeats).
 */
function keyedParts(parts: FooterPart[], model: string | undefined): SubBarPart[] {
  let all: Unkeyed[] = parts;
  if (all.length === 0) all = model ? [{ text: model, kind: "model" }] : [];
  const seen = new Map<string, number>();
  return all.map((part) => {
    const count = seen.get(part.text) ?? 0;
    seen.set(part.text, count + 1);
    return { text: part.text, kind: part.kind, tone: part.tone, key: `${part.text}#${count}` };
  });
}

interface Unkeyed {
  text: string;
  kind: LineKind;
  tone?: FooterPart["tone"];
}

interface SubBarPart {
  text: string;
  kind: LineKind;
  tone?: FooterPart["tone"];
  key: string;
}

/** Slack for kerning between separately measured runs (the line is drawn as one run). */
const FIT_SLACK = 2;

/**
 * The sub-bar's parts fitted to its width as forge fits its line (`fitLine`): measured off-screen
 * once per text, then whole parts dropped in forge's order; never an item cut in half.
 */
function useFittedParts(all: SubBarPart[]) {
  const [room, setRoom] = useState<number | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [sepWidth, setSepWidth] = useState<number | null>(null);
  const onRoom = useCallback((e: LayoutChangeEvent) => setRoom(e.nativeEvent.layout.width), []);
  const onSep = useCallback((e: LayoutChangeEvent) => setSepWidth(e.nativeEvent.layout.width), []);
  const measure = useCallback(
    (key: string, width: number) =>
      setWidths((prev) => (prev[key] === width ? prev : { ...prev, [key]: width })),
    [],
  );
  const ready =
    room !== null && sepWidth !== null && all.every((part) => widths[part.key] !== undefined);
  const shown = ready
    ? fitLine(
        all.map((part) => ({ ...part, width: widths[part.key]! })),
        room - FIT_SLACK,
        sepWidth,
      )
    : all;
  return { shown, onRoom, onSep, measure };
}

function MeasuredText({
  part,
  onWidth,
}: {
  part: SubBarPart;
  onWidth: (key: string, width: number) => void;
}) {
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => onWidth(part.key, e.nativeEvent.layout.width),
    [onWidth, part.key],
  );
  return (
    <Text style={styles.measureText} numberOfLines={1} onLayout={onLayout}>
      {part.text}
    </Text>
  );
}

/** The context field's colour, as the desktop line colours it (warning/error); else inherited. */
function toneStyle(tone: FooterPart["tone"]) {
  if (tone === "warning") return styles.toneWarning;
  if (tone === "error") return styles.toneError;
  return undefined;
}

function SessionFooter({
  row,
  connection,
  hidden,
  footer,
}: {
  row: SessionRow;
  connection: HostConnectionState;
  /** The answer dock holds the input's place: forge draws no line then. */
  hidden: boolean;
  /** forge's status-line items (model · effort · ctx · cost), when it publishes them. */
  footer?: RemoteFooter | null;
}) {
  // forge's line and nothing else; while the connection is not live its facts are stale: dimmed.
  const all = keyedParts(footerParts(footer), shortModel(row.model));
  const fitted = useFittedParts(all);
  if (hidden || all.length === 0) return null;
  const dimmed = footerDimmed(connection.status);
  return (
    <View style={styles.subBar} testID="session-footer">
      <Text
        style={[styles.subBarText, dimmed && styles.subBarQuiet]}
        numberOfLines={1}
        onLayout={fitted.onRoom}
        testID="session-state"
      >
        {fitted.shown.map((part, index) => (
          <Text key={part.key} style={toneStyle(part.tone)}>
            {index === 0 ? part.text : ` · ${part.text}`}
          </Text>
        ))}
      </Text>
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={styles.measureText} numberOfLines={1} onLayout={fitted.onSep}>
          {" · "}
        </Text>
        {all.map((part) => (
          <MeasuredText key={part.key} part={part} onWidth={fitted.measure} />
        ))}
      </View>
    </View>
  );
}

/** Ticks once a second while `on` (the working row's clock). */
function useSecondTick(on: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [on]);
}

/**
 * pi's working row at the newest transcript edge: spinner and verb in the working colour,
 * the run's clock muted. The app cannot see forge's per-run verb or token count, so it shows
 * pi's own verb and the clock only.
 */
function WorkingRow({ hostId, since }: { hostId: string; since: number }) {
  const { t } = useTranslation();
  useSecondTick(true);
  const clock = workingClock(since, hostNow(connectionStore.getState().getService(hostId)));
  return (
    <View
      style={styles.workingRow}
      accessible
      accessibilityLabel={t("pi.session.workingLabel", { clock })}
      testID="chat-working"
    >
      <SessionGlyph kind="working" running />
      <Text style={styles.workingText}>
        {t("pi.session.working")}
        <Text style={styles.workingClock}>{` (${clock})`}</Text>
      </Text>
    </View>
  );
}

interface ChatPaneProps {
  hostId: string;
  row: SessionRow;
  entry: SessionsEntry | undefined;
  active: boolean;
  connection: HostConnectionState;
  /** The answer dock holds the input's place (no working row then). */
  held: boolean;
  channel: RemoteChannel;
  /** A `/` name the app opens natively (a screen or a sheet). */
  openNative: (tool: NativeTool, arg: string) => void;
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

function ChatPaneBody({
  hostId,
  row,
  active,
  connection,
  held,
  channel,
  openNative,
}: ChatPaneProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const feed = useChatFeed(hostId, row, active);
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
          const outcome = refusalOutcome(name, error.detail, error.reason);
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
      // The CLI's names for forge's views open their native screens (never pasted into pi's TUI).
      const target = row.live ? nativeTarget(text) : undefined;
      if (target) {
        openNative(target.tool, target.arg);
        return true;
      }
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
    [channel.available, channel.state?.commands, feed, hostId, openNative, row, runCommand],
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
  const pickNative = useCallback(
    (command: RemoteCommand) => {
      const tool = NATIVE_COMMANDS[command.name];
      if (!tool || !row.live) return false;
      openNative(tool, "");
      return true;
    },
    [openNative, row.live],
  );
  // A prompt handed back by /rewind lands in the composer when the chat is shown again.
  const [prefill, setPrefill] = useState<{ text: string } | undefined>(undefined);
  // One hand-back fills the field once: the composer remounts whenever pi's dialog replaces it.
  const prefillApplied = useCallback(() => setPrefill(undefined), []);
  const sessionId = row.sessionId;
  useFocusEffect(
    useCallback(() => {
      const handed = takeHandBack(sessionId);
      if (handed) setPrefill({ text: handed.text });
    }, [sessionId]),
  );
  const askingGlyph = useMemo(() => <SessionGlyph kind="needs" />, []);
  const errorMessage = sendError
    ? [t(sendError.key), sendError.detail].filter(Boolean).join(" ")
    : "";
  const working = workingRowVisible(row.state, connection.status, held);
  const activity = useMemo(
    () => (working ? <WorkingRow hostId={hostId} since={row.since} /> : null),
    [working, hostId, row.since],
  );

  return (
    <View style={FILL}>
      {feed.hasFile || working ? (
        <ChatView rows={feed.rows} loading={feed.loading} activity={activity} />
      ) : (
        <View style={FILL} testID="chat-no-file" />
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
          <NoteRow
            text={notice.text}
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
          onPickNative={pickNative}
          prefill={prefill}
          onPrefillApplied={prefillApplied}
          placeholder={t(composerPlaceholderKey(row))}
          onSubmit={send}
          busy={sending}
          canStop={row.live && row.state === "working"}
          onStop={stop}
          testID="chat-composer"
          sendTestID="chat-send"
          stopTestID="chat-stop"
        />
      </AnswerDock>
      <SessionFooter
        row={row}
        connection={connection}
        hidden={held}
        footer={channel.available ? channel.state?.footer : undefined}
      />
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
  // forge's line right under the input: the composer's text column, no rule of its own.
  subBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  workingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  // forge: the spinner and verb in pi's working sky blue (75), the clock in grey (246).
  // Light uses the palette's blue 600 (5.2:1 on white; the light running dot is 3.6:1).
  workingText: {
    flex: 1,
    color:
      theme.colorScheme === "light"
        ? theme.colors.palette.blue[600]
        : theme.colors.statusDotRunning,
    fontSize: theme.fontSize.base,
  },
  workingClock: { color: theme.colors.foregroundMuted },
  subBarText: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  subBarQuiet: { color: theme.colors.foregroundExtraMuted },
  measure: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 10_000,
    flexDirection: "row",
    alignItems: "flex-start",
    opacity: 0,
  },
  measureText: { flexShrink: 0, fontSize: theme.fontSize.sm },
  toneWarning: { color: theme.colors.statusWarning },
  toneError: { color: theme.colors.statusDanger },
  banners: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
}));
