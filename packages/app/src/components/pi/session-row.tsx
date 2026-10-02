// One dashboard row, as forge's sessions page draws it: glyph · title · short model · age.

import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, type PressableStateCallbackType } from "react-native";
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
      <Text style={[styles.title, !row.live && styles.titleClosed]} numberOfLines={1}>
        {title}
      </Text>
      {model ? (
        <Text style={styles.model} numberOfLines={1}>
          {model}
        </Text>
      ) : null}
      <Text style={styles.age}>{age}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  pressed: { backgroundColor: theme.colors.interactionHighlight },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 22,
  },
  titleClosed: { color: theme.colors.foregroundMuted },
  model: {
    flexShrink: 1,
    maxWidth: "40%",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  age: {
    minWidth: 28,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
