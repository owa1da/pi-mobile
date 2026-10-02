// Bottom composer: a multiline field and one round button that is Send, or Stop while a run is
// working and the field is empty (same coordinates, never an extra control). With `commands`, a
// leading `/` opens forge's `/` menu above the field, filtered as the name is typed.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import {
  MutedSpinner,
  ThemedArrowUp,
  ThemedSquare,
  accentForegroundColor,
  extraMutedColor,
  surfaceSolid,
} from "./icons";
import { MIN_TOUCH } from "@/styles/touch";
import { completeCommand, filterCommands, menuRows, slashQuery } from "@/remote/menu";
import type { RemoteCommand } from "@/remote/types";
import { SlashMenu } from "./slash-menu";

const ComposerInput = withUnistyles(AdaptiveTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

interface ComposerProps {
  placeholder: string;
  /** Resolve true when sent; false keeps the text so nothing typed is lost. */
  onSubmit: (text: string) => Promise<boolean>;
  busy?: boolean;
  /** Show Stop while the field is empty. */
  canStop?: boolean;
  onStop?: () => void;
  hint?: string;
  testID: string;
  sendTestID: string;
  stopTestID?: string;
  /** forge's `/` menu rows (sessions with the remote channel only). */
  commands?: readonly RemoteCommand[];
  /** A tapped row the app opens natively: return true and the field is cleared, not completed. */
  onPickNative?: (command: RemoteCommand) => boolean;
  /** Text put into the field each time a new object arrives (a rewound prompt), then left to the user. */
  prefill?: { text: string };
  /**
   * Called once the prefill is in the field: the owner drops it, so a later remount of the composer
   * (pi's dialog replaced it, then closed) never puts the same text back.
   */
  onPrefillApplied?: () => void;
}

export function Composer({
  placeholder,
  onSubmit,
  busy = false,
  canStop = false,
  onStop,
  hint,
  testID,
  sendTestID,
  stopTestID,
  commands,
  onPickNative,
  prefill,
  onPrefillApplied,
}: ComposerProps) {
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const [text, setText] = useState("");
  // `busy` arrives a render late: a second tap in the same frame must not submit twice.
  const submittingRef = useRef(false);
  const hasText = text.trim().length > 0;
  const showStop = canStop && !hasText && Boolean(onStop);
  const { matches, pickCommand } = useSlashMenu(
    commands,
    busy,
    text,
    inputRef,
    setText,
    onPickNative,
  );
  useEffect(() => {
    if (!prefill) return;
    const value = prefill.text;
    inputRef.current?.replaceText(value, { start: value.length, end: value.length });
    setText(value);
    onPrefillApplied?.();
  }, [onPrefillApplied, prefill]);

  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value || busy || submittingRef.current) return;
    submittingRef.current = true;
    inputRef.current?.reset();
    setText("");
    try {
      const sent = await onSubmit(value);
      if (!sent) {
        inputRef.current?.replaceText(value);
        setText(value);
      }
    } finally {
      submittingRef.current = false;
    }
  }, [busy, onSubmit, text]);

  const press = useCallback(() => {
    if (showStop) onStop?.();
    else void submit();
  }, [onStop, showStop, submit]);

  const disabled = !showStop && (!hasText || busy);
  const a11yState = useMemo(() => ({ disabled, busy }), [busy, disabled]);
  let icon = (
    <ThemedArrowUp size={20} uniProps={disabled ? extraMutedColor : accentForegroundColor} />
  );
  if (showStop) icon = <ThemedSquare size={14} uniProps={surfaceSolid} />;
  else if (busy) icon = <MutedSpinner size="small" />;

  return (
    <View style={styles.wrap}>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {matches.length > 0 ? <SlashMenu commands={matches} onPick={pickCommand} /> : null}
      <View style={styles.row}>
        <ComposerInput
          ref={inputRef}
          onChangeText={setText}
          placeholder={placeholder}
          multiline
          editable={!busy}
          style={styles.input}
          accessibilityLabel={placeholder}
          testID={testID}
        />
        <Pressable
          onPress={press}
          disabled={disabled}
          style={[
            styles.button,
            showStop && styles.stop,
            !showStop && !disabled && styles.send,
            disabled && styles.disabled,
          ]}
          accessibilityRole="button"
          accessibilityLabel={showStop ? t("pi.session.stop") : t("pi.session.send")}
          accessibilityState={a11yState}
          testID={showStop ? (stopTestID ?? `${sendTestID}-stop`) : sendTestID}
        >
          {icon}
        </Pressable>
      </View>
    </View>
  );
}

/** forge's `/` menu for the composer: rows matching the typed name, and a tap that completes it. */
function useSlashMenu(
  commands: readonly RemoteCommand[] | undefined,
  busy: boolean,
  text: string,
  inputRef: RefObject<EditingTextInputHandle | null>,
  setText: (text: string) => void,
  onPickNative?: (command: RemoteCommand) => boolean,
) {
  const { t } = useTranslation();
  const rows = useMemo(
    () => (commands ? menuRows(commands, (sub) => t(`pi.remote.mcp.${sub}`)) : undefined),
    [commands, t],
  );
  const query = rows && !busy ? slashQuery(text) : undefined;
  const matches = useMemo(
    () => (query !== undefined && rows ? filterCommands(rows, query) : []),
    [rows, query],
  );
  const pickCommand = useCallback(
    (command: RemoteCommand) => {
      if (onPickNative?.(command)) {
        inputRef.current?.reset();
        setText("");
        return;
      }
      const next = completeCommand(command);
      inputRef.current?.replaceText(next, { start: next.length, end: next.length });
      setText(next);
      inputRef.current?.focus();
    },
    [inputRef, onPickNative, setText],
  );
  return { matches, pickCommand };
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  hint: {
    paddingHorizontal: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  row: { flexDirection: "row", alignItems: "flex-end", gap: theme.spacing[2] },
  input: {
    flex: 1,
    minHeight: MIN_TOUCH,
    maxHeight: 160,
    paddingHorizontal: theme.spacing[4],
    // One 22dp line centred in the touch-floor field.
    paddingTop: (MIN_TOUCH - 22) / 2,
    paddingBottom: (MIN_TOUCH - 22) / 2,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    lineHeight: 22,
  },
  button: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  send: { backgroundColor: theme.colors.accent },
  stop: { backgroundColor: theme.colors.foreground },
  disabled: { backgroundColor: theme.colors.surface2 },
}));
