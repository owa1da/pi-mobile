// Compact key bar above the keyboard: esc, tab, sticky ctrl, arrows, enter. In the collapsed
// landscape terminal a leading "‹ Chat" key switches back to Chat and restores the chrome.

import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { BAR_KEYS, type BarKey } from "@/screens/session/key-encoding";
import { MIN_TOUCH } from "@/styles/touch";

/** Key caps are fixed touch-floor cells in one row: their glyphs grow to 1.3× at most, never clip. */
const KEY_CAP_MAX_SCALE = 1.3;
const KEY_GAP = 4;
const SELECTED = { selected: true };
const UNSELECTED = { selected: false };

function ctrlState(key: BarKey, armed: boolean) {
  if (key !== "Ctrl") return undefined;
  return armed ? SELECTED : UNSELECTED;
}

interface KeyBarProps {
  ctrlArmed: boolean;
  onKey: (key: BarKey) => void;
  /** When set, a leading "‹ Chat" key is shown (collapsed landscape terminal). */
  onToChat?: () => void;
}

export function KeyBar({ ctrlArmed, onKey, onToChat }: KeyBarProps) {
  return (
    <View style={styles.bar} testID="key-bar">
      {onToChat ? <ToChatCap onPress={onToChat} /> : null}
      {BAR_KEYS.map((key) => (
        <KeyCap key={key} barKey={key} armed={key === "Ctrl" && ctrlArmed} onKey={onKey} />
      ))}
    </View>
  );
}

function ToChatCap({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      style={[styles.hit, styles.toChatHit]}
      focusable={false}
      accessibilityRole="button"
      accessibilityLabel={t("pi.terminal.keyLabels.ToChat")}
      testID="key-to-chat"
    >
      {({ pressed }: PressableStateCallbackType) => (
        <View style={[styles.key, styles.toChat, pressed && styles.pressed]}>
          <Text
            style={[styles.label, styles.toChatLabel]}
            maxFontSizeMultiplier={KEY_CAP_MAX_SCALE}
          >
            {t("pi.terminal.toChat")}
          </Text>
        </View>
      )}
    </Pressable>
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
  return (
    <Pressable
      onPress={press}
      style={styles.hit}
      focusable={false}
      accessibilityRole="button"
      accessibilityLabel={t(`pi.terminal.keyLabels.${barKey}`)}
      accessibilityState={ctrlState(barKey, armed)}
      testID={`key-${barKey.toLowerCase()}`}
    >
      {({ pressed }: PressableStateCallbackType) => (
        <View style={[styles.key, armed && styles.armed, pressed && styles.pressed]}>
          <Text
            style={[styles.label, armed && styles.armedLabel]}
            maxFontSizeMultiplier={KEY_CAP_MAX_SCALE}
          >
            {t(`pi.terminal.keys.${barKey}`)}
          </Text>
        </View>
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  // The 4dp gap between key caps belongs to their touch targets (2dp each side), so every key's
  // hit area is ≥48dp wide on a 411dp phone while the caps look exactly as before.
  bar: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[2] - KEY_GAP / 2,
    paddingVertical: theme.spacing[1.5],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  hit: {
    flex: 1,
    // The touch-target floor (48dp Android, 44pt iOS); the bar adds 6dp above and below.
    height: MIN_TOUCH,
    paddingHorizontal: KEY_GAP / 2,
  },
  toChatHit: { flex: 1.6 },
  key: {
    flex: 1,
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
  toChat: { backgroundColor: theme.colors.surface3 },
  toChatLabel: { fontFamily: theme.fontFamily.ui, fontWeight: theme.fontWeight.medium },
}));
