// The composer's `/` menu: forge's rows (name + description) filtered as the name is typed; a
// tap completes the name. Shown above the field, inside the composer, at most ~5 rows tall.

import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { rowTestId } from "@/remote/menu";
import type { RemoteCommand } from "@/remote/types";
import { MIN_TOUCH } from "@/styles/touch";

const ROW_HEIGHT = MIN_TOUCH + 4;

const CommandRow = memo(function CommandRow({
  command,
  onPick,
}: {
  command: RemoteCommand;
  onPick: (command: RemoteCommand) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => onPick(command), [command, onPick]);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.row, pressed && styles.pressed],
    [],
  );
  return (
    <Pressable
      onPress={press}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={
        command.description
          ? t("pi.remote.commandRow", { name: command.name, description: command.description })
          : `/${command.name}`
      }
      testID={`slash-row-${rowTestId(command.name)}`}
    >
      <Text style={styles.name} numberOfLines={1}>
        /{command.name}
      </Text>
      {command.description ? (
        <Text style={styles.description} numberOfLines={1}>
          {command.description}
        </Text>
      ) : null}
    </Pressable>
  );
});

export function SlashMenu({
  commands,
  onPick,
}: {
  commands: readonly RemoteCommand[];
  onPick: (command: RemoteCommand) => void;
}) {
  const { t } = useTranslation();
  return (
    <ScrollView
      style={styles.menu}
      keyboardShouldPersistTaps="always"
      accessibilityLabel={t("pi.remote.commands")}
      testID="slash-menu"
    >
      {commands.map((command) => (
        <CommandRow key={command.name} command={command} onPick={onPick} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  menu: {
    maxHeight: ROW_HEIGHT * 5 + ROW_HEIGHT / 2,
    borderRadius: theme.borderRadius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  row: {
    minHeight: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  pressed: { backgroundColor: theme.colors.interactionHighlight },
  name: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
  },
  description: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
