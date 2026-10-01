// Centered empty / not-found state: optional mark, one title, one sentence, at most one action.

import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionTestID?: string;
  actionLoading?: boolean;
  testID?: string;
}

export function EmptyState({
  icon,
  title,
  body,
  actionLabel,
  onAction,
  actionTestID,
  actionLoading,
  testID,
}: EmptyStateProps) {
  return (
    <View style={styles.container} testID={testID}>
      {icon}
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {actionLabel && onAction ? (
        <Button
          variant="default"
          onPress={onAction}
          testID={actionTestID}
          loading={actionLoading}
          style={styles.action}
        >
          {actionLabel}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[8],
    gap: theme.spacing[2],
  },
  title: {
    marginTop: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  body: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    textAlign: "center",
    maxWidth: 320,
  },
  action: { marginTop: theme.spacing[4], minWidth: 160 },
}));
