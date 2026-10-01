// Compact key bar above the keyboard: esc, tab, sticky ctrl, arrows, enter.

import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { BAR_KEYS, type BarKey } from "@/screens/session/key-encoding";

const SELECTED = { selected: true };
const UNSELECTED = { selected: false };

function ctrlState(key: BarKey, armed: boolean) {
  if (key !== "Ctrl") return undefined;
  return armed ? SELECTED : UNSELECTED;
}

interface KeyBarProps {
  ctrlArmed: boolean;
  onKey: (key: BarKey) => void;
}

export function KeyBar({ ctrlArmed, onKey }: KeyBarProps) {
  return (
    <View style={styles.bar} testID="key-bar">
      {BAR_KEYS.map((key) => (
        <KeyCap key={key} barKey={key} armed={key === "Ctrl" && ctrlArmed} onKey={onKey} />
      ))}
    </View>
  );
}

const KeyCap = memo(function KeyCap({
  barKey,
  armed,
  onKey,
}: {
  barKey: BarKey;
  armed: boolean;
  onKey: (key: BarKey) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => onKey(barKey), [barKey, onKey]);
  const style = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.key,
      armed && styles.armed,
      pressed && styles.pressed,
    ],
    [armed],
  );
  return (
    <Pressable
      onPress={press}
      style={style}
      focusable={false}
      accessibilityRole="button"
      accessibilityLabel={t(`pi.terminal.keyLabels.${barKey}`)}
      accessibilityState={ctrlState(barKey, armed)}
      testID={`key-${barKey.toLowerCase()}`}
    >
      <Text style={[styles.label, armed && styles.armedLabel]}>
        {t(`pi.terminal.keys.${barKey}`)}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  key: {
    flex: 1,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  pressed: { backgroundColor: theme.colors.surface3 },
  armed: { backgroundColor: theme.colors.foreground },
  label: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
  },
  armedLabel: { color: theme.colors.surface0 },
}));
