// One saved host: name, user@host, and its connection state. Tap connects; the pencil edits.

import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SavedHost } from "@/host/types";
import type { HostConnectionState } from "@/stores/connection-store";
import { hostAddress } from "@/stores/host-records";
import { failureText } from "./connection-text";
import { MutedSpinner, ThemedPencil, mutedColor } from "./icons";
import { MIN_TOUCH } from "@/styles/touch";

const BUSY = { busy: true };
const IDLE_A11Y = { busy: false };

interface HostRowProps {
  host: SavedHost;
  connection: HostConnectionState;
  onPress: (host: SavedHost) => void;
  onEdit: (host: SavedHost) => void;
}

export const HostRow = memo(function HostRow({ host, connection, onPress, onEdit }: HostRowProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(host), [host, onPress]);
  const handleEdit = useCallback(() => onEdit(host), [host, onEdit]);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.row, pressed && styles.pressed],
    [],
  );
  const busy = connection.status === "connecting";
  const failed = connection.status === "failed" && connection.failure;
  const mismatch = connection.failure?.kind === "host-key-mismatch";
  let note: string | null = null;
  if (busy) note = t("pi.hosts.connecting");
  else if (failed && mismatch) note = t("pi.hosts.keyChanged");
  else if (failed) note = failureText(t, connection.failure);

  return (
    <Pressable
      onPress={handlePress}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={[host.label, hostAddress(host), note].filter(Boolean).join(", ")}
      accessibilityState={busy ? BUSY : IDLE_A11Y}
      testID={`host-row-${host.id}`}
    >
      <View style={styles.main}>
        <Text style={styles.label} numberOfLines={1}>
          {host.label}
        </Text>
        <Text style={styles.address} numberOfLines={1}>
          {hostAddress(host)}
        </Text>
        {note ? (
          <Text style={[styles.note, failed ? styles.noteDanger : null]} numberOfLines={2}>
            {note}
          </Text>
        ) : null}
      </View>
      {busy ? <MutedSpinner size="small" /> : null}
      <Pressable
        onPress={handleEdit}
        style={styles.edit}
        accessibilityRole="button"
        accessibilityLabel={t("pi.hosts.edit", { label: host.label })}
        testID={`host-edit-${host.id}`}
      >
        <ThemedPencil size={18} uniProps={mutedColor} />
      </Pressable>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[3],
  },
  pressed: { backgroundColor: theme.colors.interactionHighlight },
  main: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    fontWeight: theme.fontWeight.medium,
  },
  address: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 17 },
  noteDanger: { color: theme.colors.statusDanger },
  edit: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: "center",
    justifyContent: "center",
  },
}));
