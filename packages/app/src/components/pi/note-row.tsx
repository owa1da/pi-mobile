// A notice in the transcript, as forge's report renderer draws one (`_lib/report.ts`,
// `look/rows.ts` noticeLines): `※ ` at the message column in the tone's colour, then the text in
// grey (an error's in red), one line; the rest only on expand. No card, no icon, no background.

import { memo, useCallback, useMemo, useState } from "react";
import {
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextLayoutEventData,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MIN_TOUCH } from "@/styles/touch";

export type NoteTone = "info" | "warning" | "error";

/** forge's notice mark (GLYPH.notice). */
export const NOTE_GLYPH = "※";

interface NoteRowProps {
  tone?: NoteTone;
  text: string;
  /** A note the reader can clear (an app-side notice, never a transcript entry). */
  dismissLabel?: string;
  onDismiss?: () => void;
  testID?: string;
}

/** The first line, and whether anything follows it. */
function splitNote(text: string): { head: string; more: boolean } {
  const body = text.trimEnd();
  const cut = body.indexOf("\n");
  if (cut < 0) return { head: body, more: false };
  return { head: body.slice(0, cut), more: body.slice(cut + 1).trim().length > 0 };
}

export const NoteRow = memo(function NoteRow({
  tone = "info",
  text,
  dismissLabel,
  onDismiss,
  testID,
}: NoteRowProps) {
  const [open, setOpen] = useState(false);
  // The head is cut at the row's width: measured on a hidden unbounded copy.
  const [wraps, setWraps] = useState(false);
  const { head, more } = useMemo(() => splitNote(text), [text]);
  const expandable = more || wraps;
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const onMeasure = useCallback(
    (e: NativeSyntheticEvent<TextLayoutEventData>) => setWraps(e.nativeEvent.lines.length > 1),
    [],
  );
  const textStyle = [styles.text, tone === "error" && styles.textError];
  const state = useMemo(() => ({ expanded: open }), [open]);
  const content = (
    <View style={styles.line}>
      <Text style={[styles.mark, styles[tone]]} importantForAccessibility="no">
        {NOTE_GLYPH}
      </Text>
      <View style={styles.body}>
        <Text style={textStyle} numberOfLines={open ? undefined : 1} selectable={open}>
          {open ? text.trimEnd() : head}
          {/* The expand cue: inline, so a head cut at the width shows one ellipsis, not two. */}
          {expandable && !open ? (
            <Text style={styles.more} testID={testID ? `${testID}-more` : "note-more"}>
              {" …"}
            </Text>
          ) : null}
        </Text>
        <Text
          style={[textStyle, styles.measure]}
          onTextLayout={onMeasure}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          {head}
        </Text>
      </View>
    </View>
  );
  return (
    <View style={styles.row} testID={testID}>
      {expandable ? (
        <Pressable
          onPress={toggle}
          style={styles.fill}
          accessibilityRole="button"
          accessibilityState={state}
          accessibilityLabel={text}
        >
          {content}
        </Pressable>
      ) : (
        <View style={styles.fill} accessible accessibilityLabel={text}>
          {content}
        </View>
      )}
      {dismissLabel && onDismiss ? (
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
          style={styles.dismiss}
          testID={testID ? `${testID}-dismiss` : undefined}
        >
          <Text style={styles.dismissText} importantForAccessibility="no">
            ×
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center", minHeight: 28 },
  fill: { flex: 1, minWidth: 0, justifyContent: "center", paddingVertical: theme.spacing[1] },
  line: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[2] },
  mark: { fontSize: theme.fontSize.base, lineHeight: 20 },
  info: { color: theme.colors.foregroundMuted },
  warning: { color: theme.colors.statusWarning },
  error: { color: theme.colors.statusDanger },
  body: { flex: 1, minWidth: 0 },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base, lineHeight: 20 },
  textError: { color: theme.colors.statusDanger },
  more: { color: theme.colors.foregroundMuted },
  measure: { position: "absolute", left: 0, right: 0, top: 0, opacity: 0 },
  dismiss: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    marginRight: -theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  dismissText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xl },
}));
