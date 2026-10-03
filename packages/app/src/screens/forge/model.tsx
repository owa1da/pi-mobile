// /model and /thinking: the thinking level (thinking.set), then forge's picker (pins.md): the
// pins until you type, then matching pins and the other models (models.list). A tap sets the model
// (model.set) and goes back, as the picker closes on Enter; the pin toggles pin.toggle.

import { router } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SearchField } from "@/components/ui/search-field";
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

/** Models unpinned while the picker is open, after a toggle of `ref` (pinned again: it leaves). */
function unpinnedAfterToggle(prev: readonly string[], ref: string, wasPinned: boolean): string[] {
  const rest = prev.filter((r) => r !== ref);
  return wasPinned ? [...rest, ref] : rest;
}

export function ModelView({ channel }: ForgeViewProps) {
  const { t } = useTranslation();
  const action = useForgeAction(channel);
  const run = action.run;
  const [list, setList] = useState<ModelList | null>(null);
  /** The latest thinking answer (thinking.set / model.set), over models.list's. */
  const [thinking, setThinking] = useState<ThinkingInfo | null | undefined>(undefined);
  /** pin.toggle's answer, until the state catches up. */
  const [pinsNow, setPinsNow] = useState<{ pinned: string[]; recent: string[] } | null>(null);
  const [query, setQuery] = useState("");
  /** Models unpinned while this picker is open: forge keeps them in an Unpinned group for undo. */
  const [unpinnedHere, setUnpinnedHere] = useState<string[]>([]);
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

  const groups = useMemo(
    () => (available ? modelGroups(available, pins, query, unpinnedHere) : []),
    [available, pins, query, unpinnedHere],
  );
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
    (ref: string) => {
      const wasPinned = pinned.has(ref);
      void run("pin.toggle", { ref }).then((out) => {
        if (!out.ok) return undefined;
        setPinsNow(parsePinsResult(out.data));
        setUnpinnedHere((prev) => unpinnedAfterToggle(prev, ref, wasPinned));
        return undefined;
      });
    },
    [pinned, run],
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
        query={query}
        onQuery={setQuery}
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
  query,
  onQuery,
  onLevel,
  onPick,
  onTogglePin,
}: {
  query: string;
  onQuery: (query: string) => void;
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
  // An other-only result list needs no heading (pins.md).
  const headed = !(groups.length === 1 && groups[0]?.key === "other");
  let empty: string | null = null;
  if (groups.length === 0)
    empty = query.trim()
      ? t("pi.forge.model.noMatch", { query: query.trim() })
      : t("pi.forge.model.noPins");
  return (
    <ScrollView testID="model-list" keyboardShouldPersistTaps="handled">
      {levels && levels.levels.length > 0 ? (
        <>
          <SectionLabel>{t("pi.forge.model.thinking")}</SectionLabel>
          <LevelRows levels={levels.levels} current={levels.level} onPick={onLevel} />
        </>
      ) : null}
      <View style={styles.search}>
        <SearchField
          value={query}
          onChangeText={onQuery}
          placeholder={t("pi.forge.model.search")}
          clearAccessibilityLabel={t("pi.forge.model.clearSearch")}
          testID="model-search"
          clearTestID="model-search-clear"
        />
      </View>
      {empty ? (
        <Text style={styles.empty} testID="model-empty">
          {empty}
        </Text>
      ) : null}
      {groups.map((group) => (
        <View key={group.key}>
          {headed ? <SectionLabel>{t(`pi.forge.model.groups.${group.key}`)}</SectionLabel> : null}
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
      subtitle={selectable ? null : t("pi.forge.model.unavailable")}
      selected={current}
      onPress={selectable ? pick : undefined}
      testID={`model-row-${ref}`}
      right={right}
    />
  );
});

/** At a large system font the levels split into two balanced rows (never an orphan chip). */
/** forge's thinking levels: two balanced rows of equal chips (3×2 for pi's six), at every font size. */
function LevelRows({
  levels,
  current,
  onPick,
}: {
  levels: readonly string[];
  current: string | null | undefined;
  onPick: (level: string) => void;
}) {
  const rows = levels.length > 3 ? 2 : 1;
  const per = Math.ceil(levels.length / rows);
  const chunks: string[][] = [];
  for (let i = 0; i < levels.length; i += per) chunks.push(levels.slice(i, i + per));
  return (
    <View style={styles.levels} accessibilityRole="radiogroup" testID="thinking-levels">
      {chunks.map((chunk) => (
        <View key={chunk.join(" ")} style={styles.levelRow}>
          {chunk.map((level) => (
            <LevelChip key={level} level={level} selected={level === current} onPick={onPick} />
          ))}
          {/* The short row keeps the long row's chip width. */}
          {Array.from({ length: per - chunk.length }, (_, i) => (
            <View key={`pad${i}`} style={styles.chipPad} />
          ))}
        </View>
      ))}
    </View>
  );
}

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
      <Text style={[styles.chipText, selected && styles.chipTextOn]} numberOfLines={1}>
        {level}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Every level visible: two balanced rows of equal chips.
  levels: {
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  levelRow: { flexDirection: "row", gap: theme.spacing[1.5] },
  chipPad: { flex: 1 },
  search: {
    minHeight: MIN_TOUCH,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  empty: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chip: {
    flex: 1,
    minWidth: 0,
    minHeight: MIN_TOUCH,
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
