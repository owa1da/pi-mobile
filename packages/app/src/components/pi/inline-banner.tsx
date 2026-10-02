// A calm, non-blocking banner: a tinted strip with a short message and at most one action.

import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { MIN_TOUCH } from "@/styles/touch";

export interface InlineBannerProps {
  tone: "warning" | "danger" | "muted";
  title?: string;
  message: string;
  leading?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  actionTestID?: string;
  dismissLabel?: string;
  onDismiss?: () => void;
  testID?: string;
  messageLines?: number;
}

export function InlineBanner({
  tone,
  title,
  message,
  leading,
  actionLabel,
  onAction,
  actionTestID,
  dismissLabel,
  onDismiss,
  testID,
  messageLines = 3,
}: InlineBannerProps) {
  return (
    <View style={[styles.banner, styles[tone]]} testID={testID} accessibilityRole="alert">
      {leading}
      <View style={styles.text}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        <Text style={styles.message} numberOfLines={messageLines} selectable>
          {message}
        </Text>
      </View>
      {actionLabel && onAction ? (
        <Button variant="secondary" onPress={onAction} testID={actionTestID}>
          {actionLabel}
        </Button>
      ) : null}
      {dismissLabel && onDismiss ? (
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
          style={styles.dismiss}
        >
          <Text style={styles.dismissText} importantForAccessibility="no">
            ×
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    // Touch-floor action and dismiss targets; the strip stays 56dp tall around them.
    paddingVertical: (56 - MIN_TOUCH) / 2,
    minHeight: 56,
    borderRadius: theme.borderRadius.xl,
  },
  warning: { backgroundColor: theme.colors.statusWarningTint },
  danger: { backgroundColor: theme.colors.statusDangerTint },
  muted: { backgroundColor: theme.colors.surface2 },
  text: { flex: 1, minWidth: 0, gap: theme.spacing[0.5] },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  dismiss: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    marginRight: -theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
  },
  dismissText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xl,
  },
}));
