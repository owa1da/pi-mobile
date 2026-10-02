// Bottom-anchored transcript: an inverted list that stays pinned to the newest output unless the
// reader scrolled up (then a "Latest" pill brings them back). Renders the kept Paseo components.

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  Pressable,
  Text,
  View,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  AssistantMessage,
  CompactionMarker,
  Notification,
  ToolCall,
  UserMessage,
} from "@/components/message";
import type { ChatRow } from "@/screens/session/chat-rows";
import { MutedSpinner, ThemedChevronDown, ThemedChevronRight, mutedColor } from "./icons";

const SHOW_JUMP_AFTER = 400;
const MAINTAIN_POSITION = { minIndexForVisible: 0, autoscrollToTopThreshold: 96 };

interface ChatViewProps {
  rows: ChatRow[];
  truncated: boolean;
  loading: boolean;
}

export function ChatView({ rows, truncated, loading }: ChatViewProps) {
  const { t } = useTranslation();
  const listRef = useRef<FlatList<ChatRow>>(null);
  const [away, setAway] = useState(false);
  const data = useMemo(() => newestFirst(rows), [rows]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setAway(event.nativeEvent.contentOffset.y > SHOW_JUMP_AFTER);
  }, []);
  const jump = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);
  const footer = useMemo(
    () => (truncated ? <Text style={styles.truncated}>{t("pi.session.truncated")}</Text> : null),
    [t, truncated],
  );

  if (loading && rows.length === 0) {
    return (
      <View style={styles.center} accessible accessibilityLabel={t("pi.session.loadingChat")}>
        <MutedSpinner size="small" />
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <FlatList
        ref={listRef}
        inverted
        data={data}
        keyExtractor={keyOf}
        renderItem={renderRow}
        ListFooterComponent={footer}
        contentContainerStyle={styles.content}
        maintainVisibleContentPosition={MAINTAIN_POSITION}
        onScroll={onScroll}
        scrollEventThrottle={100}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={9}
        testID="chat-list"
      />
      {away ? (
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
      ) : null}
    </View>
  );
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
      return <Notification level={row.level} message={row.text} />;
    case "compaction":
      return <CompactionMarker status="completed" />;
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
  content: { paddingTop: theme.spacing[4], paddingBottom: theme.spacing[2] },
  rowWrap: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
  },
  truncated: {
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[4],
  },
  jump: {
    position: "absolute",
    bottom: theme.spacing[3],
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: 44,
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  jumpText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  // The 44dp header is the target; its extra height replaces the container's vertical padding.
  thinking: { gap: theme.spacing[2] },
  thinkingHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minHeight: 44,
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
