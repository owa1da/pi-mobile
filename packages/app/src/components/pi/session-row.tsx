// One dashboard row: glyph · title · age, then the status (asking: …, error: …), then folder · model.

import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SessionRow as SessionRowData } from "@/host/types";
import { formatAge, presentRow, shortFolder, shortModel } from "@/screens/dashboard/view-model";
import { SessionGlyph } from "./session-glyph";

interface SessionRowProps {
  row: SessionRowData;
  hostNow: number;
  homeDir?: string;
  onPress: (row: SessionRowData) => void;
}

export const SessionRow = memo(function SessionRow({
  row,
  hostNow,
  homeDir,
  onPress,
}: SessionRowProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(row), [onPress, row]);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.row, pressed && styles.pressed],
    [],
  );
  const presentation = presentRow(row);
  const title = row.title || t("pi.session.title");
  const folder = shortFolder(row.cwd, homeDir);
  const model = shortModel(row.model);
  const meta = [folder, model].filter(Boolean).join(" · ");
  const status = presentation.asking
    ? `${t("pi.session.asking")}: ${presentation.status}`
    : presentation.status;
  const age = formatAge(row.since, hostNow);

  return (
    <Pressable
      onPress={handlePress}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={[title, status, age].filter(Boolean).join(", ")}
      testID={`session-row-${row.sessionId}`}
    >
      <View style={styles.glyph}>
        <SessionGlyph kind={presentation.glyph} />
      </View>
      <View style={styles.main}>
        <View style={styles.titleLine}>
          <Text style={[styles.title, !row.live && styles.titleClosed]} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.age}>{age}</Text>
        </View>
        {status ? (
          <Text
            style={[styles.status, presentation.glyph === "failed" && styles.statusDanger]}
            numberOfLines={2}
          >
            {status}
          </Text>
        ) : null}
        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  pressed: { backgroundColor: theme.colors.interactionHighlight },
  glyph: { paddingTop: 0 },
  main: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  titleLine: { flexDirection: "row", alignItems: "baseline", gap: theme.spacing[3] },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 22,
  },
  titleClosed: { color: theme.colors.foregroundMuted },
  age: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base, lineHeight: 19 },
  statusDanger: { color: theme.colors.statusDanger },
  meta: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
}));
