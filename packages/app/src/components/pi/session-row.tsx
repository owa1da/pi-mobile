// One dashboard row, as forge's sessions page draws it: glyph · title · short model · age.

import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SessionRow as SessionRowData } from "@/host/types";
import { rowAccessibilityLabel, rowStateWord } from "@/screens/dashboard/glyphs";
import { formatAge, rowGlyph, shortModel } from "@/screens/dashboard/view-model";
import { SessionGlyph } from "./session-glyph";

interface SessionRowProps {
  row: SessionRowData;
  hostNow: number;
  onPress: (row: SessionRowData) => void;
}

export const SessionRow = memo(function SessionRow({ row, hostNow, onPress }: SessionRowProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(row), [onPress, row]);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.row, pressed && styles.pressed],
    [],
  );
  const title = row.title || t("pi.session.title");
  const model = shortModel(row.model);
  const age = formatAge(row.since, hostNow);
  // At a large system font the row has two lines: the title alone on the first, `model · age` in
  // muted small text under it, so the model stays on every row and nothing wraps.
  const { fontScale } = useWindowDimensions();
  const large = fontScale >= LARGE_FONT_SCALE;

  return (
    <Pressable
      onPress={handlePress}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={rowAccessibilityLabel({
        title,
        state: t(`pi.session.stateWord.${rowStateWord(row)}`),
        model,
        age,
      })}
      testID={`session-row-${row.sessionId}`}
    >
      <SessionGlyph kind={rowGlyph(row)} />
      {large ? (
        <View style={styles.stack}>
          <Text
            style={[styles.title, styles.titleStacked, !row.live && styles.titleClosed]}
            numberOfLines={1}
            ellipsizeMode="tail"
            textBreakStrategy="simple"
            testID="dashboard-row-title"
          >
            {title}
          </Text>
          <Text
            style={styles.meta}
            numberOfLines={1}
            ellipsizeMode="tail"
            textBreakStrategy="simple"
            testID="dashboard-row-meta"
          >
            {model ? `${model} · ${age}` : age}
          </Text>
        </View>
      ) : (
        <>
          <Text
            style={[styles.title, !row.live && styles.titleClosed]}
            numberOfLines={1}
            ellipsizeMode="tail"
            textBreakStrategy="simple"
            testID="dashboard-row-title"
          >
            {title}
          </Text>
          {model ? (
            <Text
              style={styles.model}
              numberOfLines={1}
              ellipsizeMode="tail"
              textBreakStrategy="simple"
            >
              {model}
            </Text>
          ) : null}
          <Text style={styles.age}>{age}</Text>
        </>
      )}
    </Pressable>
  );
});

/** From this system font scale the row puts `model · age` on a second line under the title. */
// 1.25, not 1.3: Android reports the 1.3 setting as a float just under it.
const LARGE_FONT_SCALE = 1.25;

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  pressed: { backgroundColor: theme.colors.interactionHighlight },
  title: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 22,
  },
  titleClosed: { color: theme.colors.foregroundMuted },
  stack: { flex: 1, minWidth: 0, gap: theme.spacing[0.5] },
  titleStacked: { flexGrow: 0, flexBasis: "auto" },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  model: {
    flexShrink: 0,
    // Natural width; only an absurdly long name (or font scale 2.0) is capped, never the title's room.
    maxWidth: "45%",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  age: {
    flexShrink: 0,
    minWidth: 28,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
