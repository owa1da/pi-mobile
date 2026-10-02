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
  parseModels,
  THINKING_LEVELS,
  type ModelChoice,
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
  const [available, setAvailable] = useState<ModelChoice[] | null>(null);
  const ready = channel.available && channel.loaded;
  const pins = channel.state?.pins;
  const footer = channel.state?.footer;
  const current = footerRef(footer);
  const thinking = footer?.model?.thinking ?? "";

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void run("models.list", {}).then((out) => {
      if (!cancelled && out.ok) setAvailable(parseModels(out.data));
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
  const togglePin = useCallback((ref: string) => void run("pin.toggle", { ref }), [run]);
  const setLevel = useCallback((level: string) => void run("thinking.set", { level }), [run]);

  let body;
  if (!channel.available || action.unsupported || (channel.loaded && pins === undefined))
    body = <UpdateForge />;
  else if (!channel.loaded || available === null) body = action.error ? null : <Loading />;
  else
    body = (
      <ScrollView testID="model-list" keyboardShouldPersistTaps="handled">
        <SectionLabel>{t("pi.forge.model.thinking")}</SectionLabel>
        <View style={styles.levels} accessibilityRole="radiogroup">
          {THINKING_LEVELS.map((level) => (
            <LevelChip key={level} level={level} selected={level === thinking} onPick={setLevel} />
          ))}
        </View>
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
                onPick={pick}
                onTogglePin={togglePin}
              />
            ))}
          </View>
        ))}
      </ScrollView>
    );
  return (
    <ForgeFrame title={t("pi.forge.titles.model")}>
      {body}
      <ErrorLine message={action.error} onDismiss={action.clearError} />
    </ForgeFrame>
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
