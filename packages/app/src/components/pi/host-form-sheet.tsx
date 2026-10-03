// Add / edit host sheet: name, address, port, user, and how to sign in.

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import type { SavedHost } from "@/host/types";
import type { AuthMode } from "@/screens/hosts/host-form-logic";
import { useHostForm, type HostForm } from "@/screens/hosts/use-host-form";
import { MutedSpinner, ThemedCheck, ThemedCopy, foregroundColor } from "./icons";
import { SheetActions, sheetActionStyles } from "./sheet-actions";
import { MIN_TOUCH } from "@/styles/touch";

interface HostFormSheetProps {
  visible: boolean;
  /** null = add a new host. */
  host: SavedHost | null;
  onClose: () => void;
  onDismiss?: () => void;
  /** Edit only: the user asked to delete; the screen closes this sheet and confirms. */
  onRequestDelete?: (host: SavedHost) => void;
}

export function HostFormSheet({
  visible,
  host,
  onClose,
  onDismiss,
  onRequestDelete,
}: HostFormSheetProps) {
  const { t } = useTranslation();
  const form = useHostForm(host, onClose, onRequestDelete);
  const header = useMemo(
    () => ({ title: host ? t("pi.hostForm.editTitle") : t("pi.hostForm.addTitle") }),
    [host, t],
  );
  const save = useCallback(() => {
    void form.save();
  }, [form]);
  const footer = useMemo(
    () => (
      <SheetActions>
        <Button
          variant="ghost"
          onPress={onClose}
          style={sheetActionStyles.button}
          testID="host-form-cancel"
        >
          {t("pi.hostForm.cancel")}
        </Button>
        <Button
          variant="default"
          onPress={save}
          loading={form.saving}
          style={sheetActionStyles.button}
          testID="host-save"
        >
          {t("pi.hostForm.save")}
        </Button>
      </SheetActions>
    ),
    [form.saving, onClose, save, t],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      footer={footer}
      fitContent
      expandWithKeyboard
      testID="host-form-sheet"
    >
      <View style={styles.body}>
        <AddressFields form={form} />
        <AuthSection form={form} />
        {form.saveError ? (
          <Text style={styles.error} testID="host-save-error">
            {form.saveError}
          </Text>
        ) : null}
        {host ? (
          <View style={styles.deleteRow}>
            <Button
              variant="ghost"
              onPress={form.requestDelete}
              testID="host-delete"
              textStyle={styles.deleteText}
            >
              {t("pi.hostForm.delete")}
            </Button>
          </View>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function AddressFields({ form }: { form: HostForm }) {
  const { t } = useTranslation();
  const { fields, onChange, errors } = form;
  return (
    <>
      <Field label={t("pi.hostForm.label")}>
        <FormTextInput
          initialValue={fields.label}
          onChangeText={onChange.label}
          placeholder={t("pi.hostForm.labelPlaceholder")}
          accessibilityLabel={t("pi.hostForm.label")}
          testID="host-field-label"
        />
      </Field>
      <Field label={t("pi.hostForm.host")} error={errors.host}>
        <FormTextInput
          initialValue={fields.host}
          onChangeText={onChange.host}
          placeholder={t("pi.hostForm.hostPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel={t("pi.hostForm.host")}
          testID="host-field-host"
        />
      </Field>
      <View style={styles.pair}>
        <View style={styles.port}>
          <Field label={t("pi.hostForm.port")} error={errors.port}>
            <FormTextInput
              initialValue={fields.port}
              onChangeText={onChange.port}
              keyboardType="number-pad"
              accessibilityLabel={t("pi.hostForm.port")}
              testID="host-field-port"
            />
          </Field>
        </View>
        <View style={styles.user}>
          <Field label={t("pi.hostForm.username")} error={errors.username}>
            <FormTextInput
              initialValue={fields.username}
              onChangeText={onChange.username}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t("pi.hostForm.username")}
              testID="host-field-username"
            />
          </Field>
        </View>
      </View>
    </>
  );
}

/** From this system font scale the three ways to sign in are stacked full-width rows. */
// 1.25, not 1.3: Android reports the 1.3 setting as a float just under it.
const STACK_FONT_SCALE = 1.25;

/** The auth choice at a large font: one 48dp row per option, the selected one checked. */
function StackedChoice({
  options,
  value,
  onValueChange,
}: {
  options: SegmentedControlOption<AuthMode>[];
  value: AuthMode;
  onValueChange: (value: AuthMode) => void;
}) {
  return (
    <View style={styles.stack} accessibilityRole="radiogroup" testID="host-auth">
      {options.map((option) => (
        <StackedOption
          key={option.value}
          option={option}
          selected={option.value === value}
          onPick={onValueChange}
        />
      ))}
    </View>
  );
}

function StackedOption({
  option,
  selected,
  onPick,
}: {
  option: SegmentedControlOption<AuthMode>;
  selected: boolean;
  onPick: (value: AuthMode) => void;
}) {
  const press = useCallback(() => onPick(option.value), [onPick, option.value]);
  const state = useMemo(() => ({ checked: selected, selected }), [selected]);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.stackRow,
      selected && styles.stackRowOn,
      pressed && !selected && styles.stackRowPressed,
    ],
    [selected],
  );
  return (
    <Pressable
      onPress={press}
      accessibilityRole="radio"
      accessibilityLabel={option.label}
      accessibilityState={state}
      testID={option.testID}
      style={rowStyle}
    >
      <Text style={[styles.stackLabel, selected && styles.stackLabelOn]} numberOfLines={1}>
        {option.label}
      </Text>
      {selected ? <ThemedCheck size={18} uniProps={foregroundColor} /> : null}
    </Pressable>
  );
}

function AuthSection({ form }: { form: HostForm }) {
  const { t } = useTranslation();
  const { fontScale } = useWindowDimensions();
  const options = useMemo<SegmentedControlOption<AuthMode>[]>(
    () => [
      { value: "generate", label: t("pi.hostForm.authGenerate"), testID: "host-auth-generate" },
      { value: "paste", label: t("pi.hostForm.authPaste"), testID: "host-auth-paste" },
      { value: "password", label: t("pi.hostForm.authPassword"), testID: "host-auth-password" },
    ],
    [t],
  );
  return (
    <View style={styles.auth}>
      <Text style={styles.sectionLabel}>{t("pi.hostForm.auth")}</Text>
      {fontScale >= STACK_FONT_SCALE ? (
        <StackedChoice options={options} value={form.mode} onValueChange={form.setMode} />
      ) : (
        <SegmentedControl
          options={options}
          value={form.mode}
          onValueChange={form.setMode}
          testID="host-auth"
        />
      )}
      {form.errors.auth ? <Text style={styles.error}>{form.errors.auth}</Text> : null}
      {form.mode === "generate" ? <GeneratedKeyPanel form={form} /> : null}
      {form.mode === "paste" ? <PastedKeyPanel form={form} /> : null}
      {form.mode === "password" ? <PasswordPanel form={form} /> : null}
    </View>
  );
}

function GeneratedKeyPanel({ form }: { form: HostForm }) {
  const { t } = useTranslation();
  if (form.generateState === "generating" || (!form.generated && form.generateState === "idle")) {
    return (
      <View style={styles.inline}>
        <MutedSpinner size="small" />
        <Text style={styles.muted}>{t("pi.hostForm.generating")}</Text>
      </View>
    );
  }
  if (!form.generated) {
    return (
      <View style={styles.inline}>
        <Text style={[styles.muted, styles.flex]}>{t("pi.hostForm.generateFailed")}</Text>
        <Button onPress={form.retryGenerate} testID="host-generate-retry">
          {t("pi.hostForm.generateRetry")}
        </Button>
      </View>
    );
  }
  return (
    <View style={styles.keyBox}>
      <View style={styles.keyHeader}>
        <Text style={styles.sectionLabel}>{t("pi.hostForm.publicKey")}</Text>
        <Button
          variant="ghost"
          onPress={form.copyPublicKey}
          leftIcon={CopyIcon}
          testID="host-copy-public-key"
        >
          {t("pi.hostForm.copy")}
        </Button>
      </View>
      <Text style={styles.mono} selectable testID="host-public-key">
        {form.generated.publicKey}
      </Text>
      <Text style={styles.muted}>{t("pi.hostForm.publicKeyHint")}</Text>
    </View>
  );
}

function CopyIcon({ size }: { color: string; size: number }) {
  return <ThemedCopy size={size} uniProps={foregroundColor} />;
}

function PastedKeyPanel({ form }: { form: HostForm }) {
  const { t } = useTranslation();
  const keep = form.existing?.kind === "pasted";
  return (
    <>
      <Field label={t("pi.hostForm.privateKey")}>
        <AdaptiveTextInput
          onChangeText={form.onChange.pastedKey}
          placeholder={
            keep ? t("pi.hostForm.privateKeyKeep") : t("pi.hostForm.privateKeyPlaceholder")
          }
          multiline
          // The field grows with the key and never scrolls itself.
          scrollEnabled={false}
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
          style={styles.textArea}
          accessibilityLabel={t("pi.hostForm.privateKey")}
          testID="host-field-private-key"
        />
      </Field>
      <Field label={t("pi.hostForm.passphrase")}>
        <FormTextInput
          onChangeText={form.onChange.passphrase}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("pi.hostForm.passphrase")}
          testID="host-field-passphrase"
        />
      </Field>
    </>
  );
}

function PasswordPanel({ form }: { form: HostForm }) {
  const { t } = useTranslation();
  const keep = form.existing?.kind === "password";
  return (
    <Field label={t("pi.hostForm.password")}>
      <FormTextInput
        onChangeText={form.onChange.password}
        placeholder={keep ? t("pi.hostForm.passwordKeep") : undefined}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t("pi.hostForm.password")}
        testID="host-field-password"
      />
    </Field>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4], paddingBottom: theme.spacing[6] },
  pair: { flexDirection: "row", gap: theme.spacing[3] },
  port: { width: 96 },
  user: { flex: 1 },
  auth: { gap: theme.spacing[3], marginTop: theme.spacing[2] },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  inline: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: MIN_TOUCH,
  },
  flex: { flex: 1 },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 17 },
  keyBox: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  keyHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  mono: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  textArea: {
    minHeight: 120,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm, lineHeight: 17 },
  deleteRow: {
    marginTop: theme.spacing[2],
    paddingTop: theme.spacing[4],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    alignItems: "flex-start",
  },
  deleteText: { color: theme.colors.statusDanger },
  stack: { gap: theme.spacing[2] },
  stackRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface2,
  },
  stackRowOn: { borderColor: theme.colors.foregroundMuted },
  stackRowPressed: { backgroundColor: theme.colors.surface3 },
  stackLabel: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  stackLabelOn: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
}));
