// pi's open dialog or ask_user item, answered in place of the composer: a sheet-like panel docked
// at the bottom (never a modal), so the chat above, and the message the question refers to,
// stays in view. One tap answers a select/confirm; input/editor take text; ask items take picks
// plus free text and are submitted whole. Custom dialogs show their title only.

import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import {
  emptyDrafts,
  promptChoices,
  toggleOption,
  validateAskAnswers,
  type ItemDraft,
  type PromptReply,
} from "@/remote/answers";
import type { AskItem, AskQuestion, RemoteActionArgs, RemotePrompt } from "@/remote/types";
import { useSettledKeyboardShift } from "@/keyboard/shift";
import { MIN_TOUCH } from "@/styles/touch";
import { ThemedCheck, accentColor, accentForegroundColor } from "./icons";
import { SessionGlyph } from "./session-glyph";
import { SheetActions, sheetActionStyles } from "./sheet-actions";

/** What the panel shows after a tap: the answer went out (optimistic), or why it did not. */
export interface AnswerStatus {
  sent: boolean;
  /** The option or text sent (highlights the picked row). */
  picked?: string;
  error?: string;
}

const IDLE: AnswerStatus = { sent: false };

// ---------- shared pieces ----------

type Indicator = "none" | "radio" | "check";

interface OptionRowProps {
  label: string;
  description?: string | null;
  indicator: Indicator;
  checked: boolean;
  disabled: boolean;
  onPick: (label: string) => void;
  testID: string;
}

const OptionRow = memo(function OptionRow({
  label,
  description,
  indicator,
  checked,
  disabled,
  onPick,
  testID,
}: OptionRowProps) {
  const press = useCallback(() => onPick(label), [label, onPick]);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.option, pressed && styles.pressed],
    [],
  );
  const a11yState = useMemo(
    () => (indicator === "none" ? { disabled, selected: checked } : { disabled, checked }),
    [checked, disabled, indicator],
  );
  let role: "radio" | "checkbox" | "button" = "button";
  if (indicator === "radio") role = "radio";
  else if (indicator === "check") role = "checkbox";
  return (
    <Pressable
      onPress={press}
      disabled={disabled}
      style={rowStyle}
      accessibilityRole={role}
      accessibilityState={a11yState}
      accessibilityLabel={description ? `${label}, ${description}` : label}
      testID={testID}
    >
      {indicator === "radio" ? (
        <View style={[styles.radio, checked && styles.markOn]}>
          {checked ? <View style={styles.radioDot} /> : null}
        </View>
      ) : null}
      {indicator === "check" ? (
        <View style={[styles.box, checked && styles.boxOn]}>
          {checked ? <ThemedCheck size={14} uniProps={accentForegroundColor} /> : null}
        </View>
      ) : null}
      <View style={styles.optionText}>
        <Text style={[styles.optionLabel, disabled && !checked && styles.dim]}>{label}</Text>
        {description ? <Text style={styles.optionDescription}>{description}</Text> : null}
      </View>
      {indicator === "none" && checked ? <ThemedCheck size={18} uniProps={accentColor} /> : null}
    </Pressable>
  );
});

function PanelHeader({ title, count }: { title: string; count?: string }) {
  return (
    <View style={styles.header}>
      <SessionGlyph kind="needs" />
      <Text style={styles.headerText} numberOfLines={1}>
        {title}
      </Text>
      {count ? (
        <Text style={styles.count} testID="answer-count">
          {count}
        </Text>
      ) : null}
    </View>
  );
}

function StatusLine({ status }: { status: AnswerStatus }) {
  const { t } = useTranslation();
  if (status.sent)
    return (
      <View
        style={styles.sent}
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={t("pi.remote.sent")}
        testID="answer-sent"
      >
        <ThemedCheck size={16} uniProps={accentColor} />
        <Text style={styles.sentText}>{t("pi.remote.sent")}</Text>
      </View>
    );
  if (status.error)
    return (
      <Text style={styles.error} accessibilityLiveRegion="polite" testID="answer-error">
        {status.error}
      </Text>
    );
  return null;
}

/**
 * The scroll area: at most ~40% of the space above the keyboard, so the chat (and the message
 * being asked about) keeps the rest even while the soft keyboard is open.
 */
function PanelBody({ children }: { children: ReactNode }) {
  const { height } = useWindowDimensions();
  const keyboard = useSettledKeyboardShift();
  const cap = useMemo(
    () => ({ maxHeight: Math.max(120, Math.round((height - keyboard) * 0.4)) }),
    [height, keyboard],
  );
  return (
    <ScrollView
      style={cap}
      contentContainerStyle={styles.bodyContent}
      keyboardShouldPersistTaps="handled"
      testID="answer-scroll"
    >
      {children}
    </ScrollView>
  );
}

// ---------- pi's dialogs ----------

interface PromptPanelProps {
  prompt: RemotePrompt;
  status?: AnswerStatus;
  onRespond: (reply: PromptReply) => void;
}

/** Key by prompt.id: a new dialog starts with fresh text. */
export function PromptPanel({ prompt, status = IDLE, onRespond }: PromptPanelProps) {
  const { t } = useTranslation();
  const choices = promptChoices(prompt);
  const textual = prompt.kind === "input" || prompt.kind === "editor";
  const [text, setText] = useState(prompt.prefill ?? "");
  const locked = status.sent;
  const pick = useCallback((value: string) => onRespond({ value }), [onRespond]);
  const cancel = useCallback(() => onRespond({ cancel: true }), [onRespond]);
  const submit = useCallback(() => onRespond({ value: text }), [onRespond, text]);

  return (
    <View style={styles.panel} testID="prompt-panel">
      <PanelHeader title={t("pi.remote.asking")} />
      <PanelBody>
        <Text style={styles.title} selectable testID="prompt-title">
          {prompt.title}
        </Text>
        {prompt.message ? (
          <Text style={styles.message} selectable>
            {prompt.message}
          </Text>
        ) : null}
        {!prompt.answerable ? (
          <Text style={styles.note} testID="prompt-on-computer">
            {t("pi.remote.answerOnComputer")}
          </Text>
        ) : null}
        {prompt.answerable && !textual ? (
          <View style={styles.options}>
            {choices.map((choice, i) => (
              <OptionRow
                // Options may repeat a label; position keeps the keys unique.
                // eslint-disable-next-line react/no-array-index-key
                key={`${i}-${choice}`}
                label={choice}
                indicator="none"
                checked={locked && status.picked === choice}
                disabled={locked}
                onPick={pick}
                testID={`prompt-option-${i}`}
              />
            ))}
          </View>
        ) : null}
        {prompt.answerable && textual ? (
          <AdaptiveTextInput
            initialValue={prompt.prefill ?? ""}
            onChangeText={setText}
            placeholder={prompt.placeholder ?? t("pi.remote.answerPlaceholder")}
            accessibilityLabel={prompt.placeholder ?? t("pi.remote.answerPlaceholder")}
            multiline={prompt.kind === "editor"}
            editable={!locked}
            style={[styles.field, prompt.kind === "editor" && styles.editor]}
            testID="prompt-input"
          />
        ) : null}
        <StatusLine status={status} />
      </PanelBody>
      {prompt.answerable && !locked ? (
        <View style={styles.footer}>
          <SheetActions>
            <Button
              variant="ghost"
              onPress={cancel}
              style={sheetActionStyles.button}
              testID="prompt-cancel"
            >
              {t("pi.remote.cancel")}
            </Button>
            {textual ? (
              <Button
                variant="default"
                onPress={submit}
                style={sheetActionStyles.button}
                testID="prompt-submit"
              >
                {t("pi.remote.submit")}
              </Button>
            ) : null}
          </SheetActions>
        </View>
      ) : null}
    </View>
  );
}

// ---------- forge's ask_user ----------

interface AskItemViewProps {
  item: AskItem;
  index: number;
  draft: ItemDraft;
  locked: boolean;
  onChange: (index: number, next: ItemDraft) => void;
}

const AskItemView = memo(function AskItemView({
  item,
  index,
  draft,
  locked,
  onChange,
}: AskItemViewProps) {
  const { t } = useTranslation();
  const pick = useCallback(
    (label: string) => onChange(index, toggleOption(item, draft, label)),
    [draft, index, item, onChange],
  );
  const type = useCallback(
    (typed: string) => onChange(index, { ...draft, typed }),
    [draft, index, onChange],
  );
  const placeholder =
    item.options.length > 0 ? t("pi.remote.otherAnswer") : t("pi.remote.answerPlaceholder");
  return (
    <View style={styles.item} testID={`ask-item-${index}`}>
      {item.header ? <Text style={styles.chip}>{item.header}</Text> : null}
      <Text style={styles.title} selectable>
        {item.question}
      </Text>
      {item.multiSelect ? <Text style={styles.hint}>{t("pi.remote.pickAny")}</Text> : null}
      {item.options.length > 0 ? (
        <View style={styles.options}>
          {item.options.map((option, i) => (
            <OptionRow
              key={option.label}
              label={option.label}
              description={option.description}
              indicator={item.multiSelect ? "check" : "radio"}
              checked={draft.picked.includes(option.label)}
              disabled={locked}
              onPick={pick}
              testID={`ask-option-${index}-${i}`}
            />
          ))}
        </View>
      ) : null}
      <AdaptiveTextInput
        onChangeText={type}
        placeholder={placeholder}
        accessibilityLabel={`${item.question} ${placeholder}`}
        editable={!locked}
        style={styles.field}
        testID={`ask-typed-${index}`}
      />
    </View>
  );
});

interface AskPanelProps {
  question: AskQuestion;
  /** 1-based position among open items, and how many are open. */
  position: number;
  total: number;
  status?: AnswerStatus;
  onAnswer: (args: RemoteActionArgs["ask.answer"]) => void;
  onDismiss: () => void;
}

/** Key by question.id: a new item starts with empty answers. */
export function AskPanel({
  question,
  position,
  total,
  status = IDLE,
  onAnswer,
  onDismiss,
}: AskPanelProps) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<ItemDraft[]>(() => emptyDrafts(question));
  const change = useCallback((index: number, next: ItemDraft) => {
    setDrafts((list) => list.map((draft, i) => (i === index ? next : draft)));
  }, []);
  const checked = validateAskAnswers(question, drafts);
  const submit = useCallback(() => {
    if (checked.ok) onAnswer(checked.args);
  }, [checked, onAnswer]);
  const locked = status.sent;
  const count = total > 1 ? t("pi.remote.count", { index: position, count: total }) : undefined;
  return (
    <View style={styles.panel} testID="ask-panel">
      <PanelHeader title={t("pi.remote.questions")} count={count} />
      <PanelBody>
        {question.items.map((item, i) => (
          <AskItemView
            // Items are positional: the answer list matches them by index.
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            item={item}
            index={i}
            draft={drafts[i]}
            locked={locked}
            onChange={change}
          />
        ))}
        <StatusLine status={status} />
      </PanelBody>
      {!locked ? (
        <View style={styles.footer}>
          <SheetActions>
            <Button
              variant="ghost"
              onPress={onDismiss}
              style={sheetActionStyles.button}
              testID="ask-dismiss"
            >
              {t("pi.remote.dismiss")}
            </Button>
            <Button
              variant="default"
              onPress={submit}
              disabled={!checked.ok}
              style={sheetActionStyles.button}
              testID="ask-submit"
            >
              {t("pi.remote.submit")}
            </Button>
          </SheetActions>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingTop: theme.spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  headerText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  count: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  bodyContent: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: 21,
  },
  message: { color: theme.colors.foreground, fontSize: theme.fontSize.base, lineHeight: 20 },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base, lineHeight: 20 },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  chip: {
    alignSelf: "flex-start",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  item: { gap: theme.spacing[2] },
  options: {
    borderRadius: theme.borderRadius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  option: {
    minHeight: MIN_TOUCH + 4,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  pressed: { backgroundColor: theme.colors.interactionHighlight },
  optionText: { flex: 1, minWidth: 0, gap: theme.spacing[0.5] },
  optionLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.content },
  optionDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 17,
  },
  dim: { color: theme.colors.foregroundMuted },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: theme.colors.foregroundMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.accent },
  markOn: { borderColor: theme.colors.accent },
  box: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.base,
    borderWidth: 2,
    borderColor: theme.colors.foregroundMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
  field: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
  },
  editor: { minHeight: 96, maxHeight: 160, textAlignVertical: "top" },
  sent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: MIN_TOUCH,
  },
  sentText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.base, lineHeight: 20 },
  footer: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
}));
