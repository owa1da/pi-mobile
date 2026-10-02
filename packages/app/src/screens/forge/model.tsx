// /model and /thinking: the thinking level (thinking.set), then the models grouped as forge's
// picker groups them: Pinned, Recent, then every other model (models.list). A tap sets the model
// (model.set) and goes back, as the picker closes on Enter; the pin toggles pin.toggle.

import { router } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  ThemedCheck,
  ThemedPin,
  ThemedPinOff,
  accentColor,
  mutedColor,
} from "@/components/pi/icons";
import {
  footerRef,
  modelGroups,
  parseModelList,
  parsePinsResult,
  parseThinking,
  type ModelChoice,
  type ModelList,
  type ThinkingInfo,
} from "@/remote/views";
import { MIN_TOUCH } from "@/styles/touch";
import type { ForgeViewProps } from "./forge-screen";
import {
  ErrorLine,
  ForgeFrame,
  ListRow,
  Loading,
  SectionLabel,
  UpdateForge,
  useForgeAction,
} from "./parts";

export function ModelView({ channel }: ForgeViewProps) {
  const { t } = useTranslation();
  const action = useForgeAction(channel);
  const run = action.run;
  const [list, setList] = useState<ModelList | null>(null);
  /** The latest thinking answer (thinking.set / model.set), over models.list's. */
  const [thinking, setThinking] = useState<ThinkingInfo | null | undefined>(undefined);
  /** pin.toggle's answer, until the state catches up. */
  const [pinsNow, setPinsNow] = useState<{ pinned: string[]; recent: string[] } | null>(null);
  const ready = channel.available && channel.loaded;
  const statePins = channel.state?.pins;
  const pins = pinsNow ?? statePins;
  const footer = channel.state?.footer;
  const current = list?.current ?? footerRef(footer);
  const levels = thinking === undefined ? (list?.thinking ?? null) : thinking;
  const available = list?.available ?? null;
  // The state's pins win once they change after a toggle.
  useEffect(() => setPinsNow(null), [statePins]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void run("models.list", {}).then((out) => {
      if (!cancelled && out.ok) setList(parseModelList(out.data));
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [ready, run]);

  const groups = useMemo(() => (available ? modelGroups(available, pins) : []), [available, pins]);
  const pinned = useMemo(() => new Set(pins?.pinned ?? []), [pins]);
  const known = useMemo(() => new Set((available ?? []).map((m) => m.ref)), [available]);

  const pick = useCallback(
    (ref: string) => {
      void run("model.set", { ref }).then((out) => {
        if (out.ok) router.back();
        return undefined;
      });
    },
    [run],
  );
  const togglePin = useCallback(
    (ref: string) =>
      void run("pin.toggle", { ref }).then((out) => {
        if (out.ok) setPinsNow(parsePinsResult(out.data));
        return undefined;
      }),
    [run],
  );
  const setLevel = useCallback(
    (level: string) =>
      void run("thinking.set", { level }).then((out) => {
        if (out.ok) setThinking(parseThinking(out.data));
        return undefined;
      }),
    [run],
  );

  let body;
  if (!channel.available || action.unsupported || (channel.loaded && pins === undefined))
    body = <UpdateForge />;
  else if (!channel.loaded || available === null) body = action.error ? null : <Loading />;
  else
    body = (
      <ModelList
        levels={levels}
        groups={groups}
        pinned={pinned}
        known={known}
        current={current}
        onLevel={setLevel}
        onPick={pick}
        onTogglePin={togglePin}
      />
    );
  return (
    <ForgeFrame title={t("pi.forge.titles.model")}>
      {body}
      <ErrorLine message={action.error} onDismiss={action.clearError} />
    </ForgeFrame>
  );
}

function ModelList({
  levels,
  groups,
  pinned,
  known,
  current,
  onLevel,
  onPick,
  onTogglePin,
}: {
  levels: ThinkingInfo | null;
  groups: ReturnType<typeof modelGroups>;
  pinned: ReadonlySet<string>;
  known: ReadonlySet<string>;
  current: string | null;
  onLevel: (level: string) => void;
  onPick: (ref: string) => void;
  onTogglePin: (ref: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <ScrollView testID="model-list" keyboardShouldPersistTaps="handled">
      {levels && levels.levels.length > 0 ? (
        <>
          <SectionLabel>{t("pi.forge.model.thinking")}</SectionLabel>
          <View style={styles.levels} accessibilityRole="radiogroup">
            {levels.levels.map((level) => (
              <LevelChip
                key={level}
                level={level}
                selected={level === levels.level}
                onPick={onLevel}
              />
            ))}
          </View>
        </>
      ) : null}
      {groups.map((group) => (
        <View key={group.key}>
          <SectionLabel>{t(`pi.forge.model.groups.${group.key}`)}</SectionLabel>
          {group.models.map((model) => (
            <ModelRow
              key={`${group.key}-${model.ref}`}
              model={model}
              pinned={pinned.has(model.ref)}
              selectable={known.has(model.ref)}
              current={model.ref === current}
              onPick={onPick}
              onTogglePin={onTogglePin}
            />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const ModelRow = memo(function ModelRow({
  model,
  pinned,
  selectable,
  current,
  onPick,
  onTogglePin,
}: {
  model: ModelChoice;
  pinned: boolean;
  selectable: boolean;
  current: boolean;
  onPick: (ref: string) => void;
  onTogglePin: (ref: string) => void;
}) {
  const { t } = useTranslation();
  const ref = model.ref;
  const pick = useCallback(() => onPick(ref), [onPick, ref]);
  const toggle = useCallback(() => onTogglePin(ref), [onTogglePin, ref]);
  const right = useMemo(
    () => (
      <View style={styles.right}>
        {current ? <ThemedCheck size={18} uniProps={accentColor} /> : null}
        <Pressable
          onPress={toggle}
          style={styles.pin}
          accessibilityRole="button"
          accessibilityLabel={t(pinned ? "pi.forge.model.unpin" : "pi.forge.model.pin", {
            name: model.name,
          })}
          testID={`model-pin-${ref}`}
        >
          {pinned ? (
            <ThemedPinOff size={18} uniProps={mutedColor} />
          ) : (
            <ThemedPin size={18} uniProps={mutedColor} />
          )}
        </Pressable>
      </View>
    ),
    [current, model.name, pinned, ref, t, toggle],
  );
  return (
    <ListRow
      title={model.name}
      subtitle={selectable ? ref : t("pi.forge.model.unavailable")}
      selected={current}
      onPress={selectable ? pick : undefined}
      testID={`model-row-${ref}`}
      right={right}
    />
  );
});

function LevelChip({
  level,
  selected,
  onPick,
}: {
  level: string;
  selected: boolean;
  onPick: (level: string) => void;
}) {
  const press = useCallback(() => onPick(level), [level, onPick]);
  const a11yState = useMemo(() => ({ selected }), [selected]);
  return (
    <Pressable
      onPress={press}
      style={[styles.chip, selected && styles.chipOn]}
      accessibilityRole="radio"
      accessibilityState={a11yState}
      accessibilityLabel={level}
      testID={`thinking-${level}`}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{level}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  levels: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  chip: {
    minHeight: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    paddingHorizontal: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  chipOn: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  chipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  chipTextOn: { color: theme.colors.accentForeground },
  right: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  pin: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
}));
