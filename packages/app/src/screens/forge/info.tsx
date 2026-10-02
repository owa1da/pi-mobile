// Read-only panels: /usage (plan numbers per account, a bar per limit, refresh), /cost (pi's
// Session Info as /cost shows it, from cost.read) and /changelog (markdown, the chat's renderer).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import {
  accountHeading,
  accountNote,
  costSections,
  meterDetail,
  parseChangelog,
  parseUsage,
  usageAt,
  type CostSection,
  type UsageAccount,
} from "@/remote/views";
import type { ForgeViewProps } from "./forge-screen";
import {
  ErrorLine,
  ForgeFrame,
  forgeStyles,
  Loading,
  TranscriptProviders,
  UpdateForge,
  useForgeAction,
} from "./parts";

export function UsageView({ channel }: ForgeViewProps) {
  const { t } = useTranslation();
  const action = useForgeAction(channel);
  const run = action.run;
  const [accounts, setAccounts] = useState<UsageAccount[] | null>(null);
  /** forge's snapshot time (host clock) and when the phone got it: "Resets in" counts from the host. */
  const [clock, setClock] = useState<{ at: number; got: number } | null>(null);
  const ready = channel.available && channel.loaded;
  const refresh = useCallback(
    async (force: boolean) => {
      const out = await run("usage.refresh", force ? { force: true } : {});
      if (!out.ok) return;
      setAccounts(parseUsage(out.data));
      const at = usageAt(out.data);
      setClock(at === null ? null : { at, got: Date.now() });
    },
    [run],
  );
  useEffect(() => {
    if (ready) void refresh(false);
  }, [ready, refresh]);
  const pressRefresh = useCallback(() => void refresh(true), [refresh]);

  const now = clock ? clock.at + (Date.now() - clock.got) : Date.now();
  let body;
  if (!channel.available || action.unsupported) body = <UpdateForge />;
  else if (accounts === null) body = action.error ? null : <Loading />;
  else if (accounts.length === 0)
    body = (
      <Text style={forgeStyles.intro} testID="usage-empty">
        {t("pi.forge.usage.empty")}
      </Text>
    );
  else
    body = (
      <ScrollView contentContainerStyle={forgeStyles.scroll} testID="usage-list">
        {accounts.map((account) => {
          const note = accountNote(account, now);
          return (
            <View key={account.id} style={styles.account}>
              <Text style={styles.heading} accessibilityRole="header">
                {accountHeading(account)}
              </Text>
              {note ? (
                <Text style={note.error ? styles.noteError : forgeStyles.muted}>{note.text}</Text>
              ) : null}
              {account.meters.map((meter) => {
                const detail = meterDetail(meter, now);
                return (
                  <View
                    key={meter.label}
                    style={styles.meter}
                    accessible
                    accessibilityLabel={[meter.label, meter.value, detail]
                      .filter(Boolean)
                      .join(", ")}
                  >
                    <View style={styles.meterHead}>
                      <Text style={styles.label}>{meter.label}</Text>
                      <Text style={forgeStyles.muted}>{meter.value}</Text>
                    </View>
                    {meter.ratio !== null ? (
                      <View style={styles.track}>
                        <View
                          style={[styles.fillBar, { width: `${Math.round(meter.ratio * 100)}%` }]}
                        />
                      </View>
                    ) : null}
                    {detail ? <Text style={forgeStyles.muted}>{detail}</Text> : null}
                  </View>
                );
              })}
            </View>
          );
        })}
      </ScrollView>
    );
  return (
    <ForgeFrame title={t("pi.forge.titles.usage")}>
      {body}
      <ErrorLine message={action.error} onDismiss={action.clearError} />
      {channel.available && !action.unsupported ? (
        <View style={forgeStyles.footer}>
          <Button
            variant="secondary"
            onPress={pressRefresh}
            loading={action.busy === "usage.refresh"}
            style={styles.fill}
            testID="usage-refresh"
          >
            {t("pi.forge.usage.refresh")}
          </Button>
        </View>
      ) : null}
    </ForgeFrame>
  );
}

export function CostView({ channel }: ForgeViewProps) {
  const { t } = useTranslation();
  const action = useForgeAction(channel);
  const run = action.run;
  const [sections, setSections] = useState<KeyedSection[] | null>(null);
  const ready = channel.available && channel.loaded;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void run("cost.read", {}).then((out) => {
      if (!cancelled && out.ok) setSections(keyedSections(costSections(out.data)));
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [ready, run]);
  let body;
  if (!channel.available || action.unsupported) body = <UpdateForge />;
  else if (sections === null) body = action.error ? null : <Loading />;
  else
    body = (
      <ScrollView contentContainerStyle={forgeStyles.scroll} testID="cost-rows">
        {sections.map((section) => (
          <View key={section.key} style={styles.section}>
            {section.title ? (
              <Text style={styles.heading} accessibilityRole="header">
                {section.title}
              </Text>
            ) : null}
            {section.rows.map((row) => (
              <View
                key={row.key}
                style={[styles.costRow, row.indent && styles.indent]}
                accessible
                accessibilityLabel={row.value ? `${row.label}, ${row.value}` : row.label}
              >
                <Text style={styles.label}>{row.label}</Text>
                {row.value ? (
                  <Text style={styles.value} selectable numberOfLines={2}>
                    {row.value}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    );
  return (
    <ForgeFrame title={t("pi.forge.titles.cost")}>
      {body}
      <ErrorLine message={action.error} onDismiss={action.clearError} />
    </ForgeFrame>
  );
}

export function ChangelogView({ channel }: ForgeViewProps) {
  const { t } = useTranslation();
  const action = useForgeAction(channel);
  const run = action.run;
  const [log, setLog] = useState<{ markdown: string; truncated: boolean } | null>(null);
  const ready = channel.available && channel.loaded;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void run("changelog.read", {}).then((out) => {
      if (!cancelled && out.ok) setLog(parseChangelog(out.data));
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [ready, run]);
  let body;
  if (!channel.available || action.unsupported) body = <UpdateForge />;
  else if (log === null) body = action.error ? null : <Loading />;
  else
    body = (
      <ScrollView contentContainerStyle={styles.markdown} testID="changelog">
        <TranscriptProviders>
          <MarkdownRenderer text={log.markdown || t("pi.forge.changelog.empty")} />
        </TranscriptProviders>
        {log.truncated ? (
          <Text style={forgeStyles.muted} testID="changelog-truncated">
            {t("pi.forge.changelog.truncated")}
          </Text>
        ) : null}
      </ScrollView>
    );
  return (
    <ForgeFrame title={t("pi.forge.titles.changelog")}>
      {body}
      <ErrorLine message={action.error} onDismiss={action.clearError} />
    </ForgeFrame>
  );
}

const MIN_ROW = 48;

type KeyedSection = Omit<CostSection, "rows"> & {
  key: string;
  rows: (CostSection["rows"][number] & { key: string })[];
};

/** Stable list keys for /cost's rows: section and label, numbered when a label repeats. */
function keyedSections(sections: CostSection[]): KeyedSection[] {
  const seen = new Map<string, number>();
  const keyFor = (base: string) => {
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return `${base}#${count}`;
  };
  return sections.map((section) => {
    const key = keyFor(`s:${section.title ?? ""}`);
    return {
      title: section.title,
      key,
      rows: section.rows.map((row) => ({
        label: row.label,
        value: row.value,
        indent: row.indent,
        key: keyFor(`${key}/${row.label}`),
      })),
    };
  });
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1 },
  account: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  section: { paddingTop: theme.spacing[3] },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    paddingHorizontal: 0,
  },
  noteError: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  meter: { gap: theme.spacing[1], paddingTop: theme.spacing[1] },
  meterHead: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[3] },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base, flexShrink: 0 },
  value: {
    flex: 1,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  track: {
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  fillBar: {
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  costRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    minHeight: MIN_ROW,
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  indent: { paddingLeft: theme.spacing[8] },
  markdown: { paddingHorizontal: theme.spacing[4], paddingVertical: theme.spacing[3] },
}));
