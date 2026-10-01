// Bottom composer: a multiline field and one round button that is Send, or Stop while a run is
// working and the field is empty (same coordinates, never an extra control).

import { useCallback, useMemo, useRef, useState } from "react";
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
  surfaceColor,
} from "./icons";

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
}: ComposerProps) {
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const [text, setText] = useState("");
  const hasText = text.trim().length > 0;
  const showStop = canStop && !hasText && Boolean(onStop);

  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value || busy) return;
    inputRef.current?.reset();
    setText("");
    const sent = await onSubmit(value);
    if (!sent) {
      inputRef.current?.replaceText(value);
      setText(value);
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
  if (showStop) icon = <ThemedSquare size={14} uniProps={surfaceColor} fill="currentColor" />;
  else if (busy) icon = <MutedSpinner size="small" />;

  return (
    <View style={styles.wrap}>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
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
    minHeight: 44,
    maxHeight: 160,
    paddingHorizontal: theme.spacing[4],
    paddingTop: 11,
    paddingBottom: 11,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    lineHeight: 22,
  },
  button: {
    width: 44,
    height: 44,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  send: { backgroundColor: theme.colors.accent },
  stop: { backgroundColor: theme.colors.foreground },
  disabled: { backgroundColor: theme.colors.surface2 },
}));
