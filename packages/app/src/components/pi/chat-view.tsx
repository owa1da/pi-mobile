// Bottom-anchored transcript: an inverted list that stays pinned to the newest output unless the
// reader scrolled up (then a "Latest" pill brings them back). Renders the kept Paseo components.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  Pressable,
  Text,
  View,
  type ListRenderItem,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AssistantMessage, ToolCall, UserMessage } from "@/components/message";
import { getChatHistory, type ChatRow } from "@/screens/session/chat-rows";
import { MutedSpinner, ThemedChevronDown, ThemedChevronRight, mutedColor } from "./icons";
import { MIN_TOUCH } from "@/styles/touch";
import { NoteRow } from "./note-row";

const SHOW_JUMP_AFTER = 400;
/** Toggle the overlay only once scrolling has settled, never mid-fling. */
const SETTLE_MS = 180;
const MAINTAIN_POSITION = { minIndexForVisible: 0, autoscrollToTopThreshold: 96 };

interface ChatViewProps {
  rows: ChatRow[];
  loading: boolean;
  /** Inverted-list header: beneath the newest output, inside the scrollable transcript. */
  activity?: ReactElement | null;
  /** Local optimistic echoes only; incoming output and history never advance this. */
  localSendCount?: number;
  /** Owned with the send counter so replacing this list cannot replay a handled send. */
  localSendScroll?: RefObject<number>;
}

export function ChatView({
  rows,
  loading,
  activity,
  localSendCount = 0,
  localSendScroll,
}: ChatViewProps) {
  const { t } = useTranslation();
  const listRef = useRef<FlatList<ChatRow>>(null);
  const data = useMemo(() => newestFirst(rows), [rows]);
  const { away, onScroll, jump } = useJumpToLatest(listRef);
  // Read-only transcripts have no owner/counter. Never infer a new send from a pending row.
  const fallbackScroll = useRef(localSendCount);
  const { onLayout, onContentSizeChange } = useLocalSendScroll(
    listRef,
    localSendCount,
    localSendScroll ?? fallbackScroll,
  );
  const history = getChatHistory(rows);
  const historyScroll = useRef(false);
  const requestedHistory = useRef<typeof history>(undefined);
  const lastOffset = useRef(0);
  const scroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = event.nativeEvent.contentOffset.y;
      // onEndReached also fires on mount / short lists. Only a scroll toward older rows arms it.
      if (offset > lastOffset.current) historyScroll.current = true;
      lastOffset.current = offset;
      onScroll(event);
    },
    [onScroll],
  );
  const requestOlder = useCallback(() => {
    if (!history || history.loading || requestedHistory.current === history) return;
    historyScroll.current = false;
    requestedHistory.current = history;
    history.loadOlder();
  }, [history]);
  const endReached = useCallback(() => {
    if (historyScroll.current) requestOlder();
  }, [requestOlder]);
  const oldestEdge = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      // RN can consume onEndReached on mount, even when a short list cannot scroll at all.
      const remaining = contentSize.height - layoutMeasurement.height - contentOffset.y;
      if (layoutMeasurement.height > 0 && remaining <= layoutMeasurement.height * 0.2)
        requestOlder();
    },
    [requestOlder],
  );
  const activityHeader = useMemo(
    () => (activity ? <View style={styles.rowWrap}>{activity}</View> : null),
    [activity],
  );
  const historyFooter = useMemo(
    () =>
      history?.loading ? (
        <View style={styles.historyLoading} testID="chat-history-loading">
          <MutedSpinner size="small" />
        </View>
      ) : undefined,
    [history?.loading],
  );

  if (loading && rows.length === 0 && !activity) {
    return (
      <View style={styles.center} accessible accessibilityLabel={t("pi.session.loadingChat")}>
        <MutedSpinner size="small" />
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <View style={styles.fill}>
        <FlatList
          ref={listRef}
          inverted
          data={data}
          keyExtractor={keyOf}
          renderItem={renderRow}
          ListHeaderComponent={activityHeader}
          contentContainerStyle={styles.content}
          maintainVisibleContentPosition={MAINTAIN_POSITION}
          onScroll={scroll}
          onLayout={onLayout}
          onContentSizeChange={onContentSizeChange}
          onScrollEndDrag={oldestEdge}
          onMomentumScrollEnd={oldestEdge}
          onEndReached={endReached}
          onEndReachedThreshold={0.2}
          ListFooterComponent={historyFooter}
          scrollEventThrottle={100}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          initialNumToRender={12}
          windowSize={9}
          testID="chat-list"
        />
      </View>
      {away ? (
        <View style={styles.jumpOverlay} pointerEvents="box-none" testID="chat-latest-overlay">
          <Pressable
            onPress={jump}
            style={styles.jump}
            accessibilityRole="button"
            accessibilityLabel={t("pi.session.jumpToLatest")}
            testID="chat-jump-latest"
          >
            <ThemedChevronDown size={16} uniProps={mutedColor} />
            <Text style={styles.jumpText}>{t("pi.session.jumpToLatest")}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** Effects run after the optimistic echo commits. An unmeasured list gets one content retry. */
function useLocalSendScroll(
  listRef: RefObject<FlatList<ChatRow> | null>,
  count: number,
  handled: RefObject<number>,
) {
  const laidOut = useRef(false);
  const pending = useRef<number | null>(null);
  const attempts = useRef(0);
  const attempt = useCallback(() => {
    // Only real scroll calls count; an unmeasured list waits for its layout.
    if (pending.current === null || !laidOut.current || !listRef.current) return;
    attempts.current += 1;
    try {
      listRef.current.scrollToOffset({ offset: 0, animated: true });
      pending.current = null;
    } catch {
      // RN may reject a scroll before its native list has committed content. Never loop.
    } finally {
      if (attempts.current >= 2) pending.current = null;
    }
  }, [listRef]);
  useEffect(() => {
    if (count <= handled.current) return;
    handled.current = count;
    pending.current = count;
    attempts.current = 0;
    attempt();
  }, [attempt, count, handled]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      laidOut.current = event.nativeEvent.layout.height > 0;
      attempt();
    },
    [attempt],
  );
  const onContentSizeChange = useCallback(() => attempt(), [attempt]);
  return { onLayout, onContentSizeChange };
}

/** Latest overlays the transcript; visibility never changes its viewport or scroll offset. */
function useJumpToLatest(listRef: RefObject<FlatList<ChatRow> | null>) {
  const [away, setAway] = useState(false);
  const offset = useRef(0);
  const awayRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = event.nativeEvent.contentOffset.y;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = offset.current > SHOW_JUMP_AFTER;
      if (next === awayRef.current) return;
      awayRef.current = next;
      setAway(next);
    }, SETTLE_MS);
  }, []);
  const jump = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, [listRef]);
  return { away, onScroll, jump };
}

const keyOf = (row: ChatRow) => row.key;
const EXPANDED = { expanded: true };
const COLLAPSED = { expanded: false };

function newestFirst(rows: readonly ChatRow[]): ChatRow[] {
  const out: ChatRow[] = [];
  for (let i = rows.length - 1; i >= 0; i--) out.push(rows[i]);
  return out;
}

const renderRow: ListRenderItem<ChatRow> = ({ item }) => (
  <View style={styles.rowWrap}>
    <ChatRowView row={item} />
  </View>
);

const ChatRowView = memo(function ChatRowView({ row }: { row: ChatRow }) {
  switch (row.kind) {
    case "user":
      return <UserMessage message={row.text} timestamp={row.timestamp} isPending={row.pending} />;
    case "assistant":
      return (
        <AssistantMessage
          occurrenceKey={row.key}
          message={row.text}
          timestamp={row.timestamp}
          phase={row.phase}
        />
      );
    case "thinking":
      return <ThinkingRow text={row.text} live={row.live} />;
    case "tool":
      return (
        <ToolCall
          toolName={row.toolName}
          status={row.status}
          detail={row.detail}
          error={row.error}
        />
      );
    case "notice":
      return <NoteRow tone={row.level} text={row.text} />;
    case "compaction":
      return <CompactionRow summary={row.summary} />;
    case "divider":
      return <DividerRow label={row.label} summary={row.summary} />;
  }
});

function ThinkingRow({ text, live }: { text: string; live: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <View style={styles.thinking}>
      <Pressable
        onPress={toggle}
        style={styles.thinkingHeader}
        accessibilityRole="button"
        accessibilityState={open ? EXPANDED : COLLAPSED}
      >
        {open ? (
          <ThemedChevronDown size={14} uniProps={mutedColor} />
        ) : (
          <ThemedChevronRight size={14} uniProps={mutedColor} />
        )}
        <Text style={styles.thinkingLabel}>{t("pi.session.thinking")}</Text>
        {live ? <MutedSpinner size="small" /> : null}
      </Pressable>
      {open ? (
        <Text style={styles.thinkingText} selectable>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * forge's compaction event (look.md, `_lib/look/compaction.ts`): one grey system row,
 * `✻ Compacted`, "Compacted" bold, at the message column. Tap expands pi's summary, where the
 * terminal's `(ctrl+o to expand)` hint stands; the trailing `…` is that cue.
 */
const CompactionRow = memo(function CompactionRow({ summary }: { summary?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const body = summary?.trim() ?? "";
  const state = useMemo(() => ({ expanded: open }), [open]);
  const line = (
    <View style={styles.compactLine}>
      <Text style={styles.compactText} importantForAccessibility="no">
        {COMPACTED_GLYPH}
      </Text>
      <Text style={styles.compactText} numberOfLines={1}>
        <Text style={styles.compactBold}>{t("pi.session.compacted")}</Text>
        {body && !open ? <Text testID="chat-compaction-more">{" …"}</Text> : null}
      </Text>
    </View>
  );
  if (!body)
    return (
      <View
        style={styles.compact}
        accessible
        accessibilityLabel={t("pi.session.compacted")}
        testID="chat-compaction"
      >
        {line}
      </View>
    );
  return (
    <Pressable
      onPress={toggle}
      style={styles.compact}
      accessibilityRole="button"
      accessibilityState={state}
      accessibilityLabel={t("pi.session.compacted")}
      testID="chat-compaction"
    >
      {line}
      {open ? (
        <Text style={styles.compactSummary} selectable>
          {body}
        </Text>
      ) : null}
    </Pressable>
  );
});

/** pi's spark (GLYPH.spark), the compaction row's mark. */
const COMPACTED_GLYPH = "✻";

function DividerRow({ label, summary }: { label: string; summary?: string }) {
  return (
    <View style={styles.divider}>
      <View style={styles.dividerLine}>
        <View style={styles.hairline} />
        <Text style={styles.dividerLabel}>{label}</Text>
        <View style={styles.hairline} />
      </View>
      {summary ? (
        <Text style={styles.dividerSummary} numberOfLines={3}>
          {summary}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  historyLoading: { alignItems: "center", paddingVertical: theme.spacing[2] },
  content: { paddingTop: theme.spacing[4], paddingBottom: theme.spacing[2] },
  rowWrap: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
  },
  jumpOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: theme.spacing[2],
    alignItems: "center",
  },
  jump: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  jumpText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  // The touch-floor header is the target; its extra height replaces the container's vertical padding.
  thinking: { gap: theme.spacing[2] },
  thinkingHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minHeight: MIN_TOUCH,
  },
  thinkingLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  thinkingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 21,
    paddingLeft: theme.spacing[3],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  // Same family as the note rows: grey, one line, the mark at the message column.
  compact: {
    minHeight: MIN_TOUCH,
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    gap: theme.spacing[2],
  },
  compactLine: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[2] },
  compactText: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  compactBold: { fontWeight: theme.fontWeight.semibold },
  compactSummary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
    paddingLeft: theme.spacing[6],
  },
  divider: { paddingVertical: theme.spacing[3], gap: theme.spacing[1] },
  dividerLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  hairline: { flex: 1, height: 1, backgroundColor: theme.colors.border },
  dividerLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  dividerSummary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 17,
    textAlign: "center",
  },
}));
