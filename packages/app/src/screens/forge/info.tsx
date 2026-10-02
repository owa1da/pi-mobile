// Read-only panels: /usage (plan numbers per account, a bar per limit, refresh), /cost (the rows
// /cost shows: cost.read, else the footer's cost) and /changelog (markdown, the chat's renderer).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { isRemoteError } from "@/remote/errors";
import {
  changelogMarkdown,
  costRows,
  parseUsage,
  type CostRow,
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
  const ready = channel.available && channel.loaded;
  const refresh = useCallback(async () => {
    const out = await run("usage.refresh", {});
    if (out.ok) setAccounts(parseUsage(out.data));
  }, [run]);
  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh]);
  const pressRefresh = useCallback(() => void refresh(), [refresh]);

  let body;
  if (!channel.available || action.unsupported) body = <UpdateForge />;
  else if (accounts === null) body = action.error ? null : <Loading />;
  else if (accounts.length === 0)
    body = <Text style={forgeStyles.intro}>{t("pi.forge.usage.empty")}</Text>;
  else
    body = (
      <ScrollView contentContainerStyle={forgeStyles.scroll} testID="usage-list">
        {accounts.map((account) => (
          <View key={account.title} style={styles.account}>
            <Text style={styles.heading}>{account.title}</Text>
            {account.note ? <Text style={forgeStyles.muted}>{account.note}</Text> : null}
            {account.meters.map((meter) => (
              <View
                key={meter.label}
                style={styles.meter}
                accessible
                accessibilityLabel={[
                  meter.label,
                  meter.left !== null
                    ? t("pi.forge.usage.left", { percent: meter.left })
                    : meter.value,
                  meter.detail,
                ]
                  .filter(Boolean)
                  .join(", ")}
              >
                <View style={styles.meterHead}>
                  <Text style={styles.label}>{meter.label}</Text>
                  <Text style={forgeStyles.muted}>
                    {meter.left !== null
                      ? t("pi.forge.usage.left", { percent: meter.left })
                      : meter.value}
                  </Text>
                </View>
                {meter.left !== null ? (
                  <View style={styles.track}>
                    <View style={[styles.fillBar, { width: `${meter.left}%` }]} />
                  </View>
                ) : null}
                {meter.detail ? <Text style={forgeStyles.muted}>{meter.detail}</Text> : null}
              </View>
            ))}
          </View>
        ))}
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
  const send = channel.send;
  const footer = channel.state?.footer;
  const [data, setData] = useState<unknown>(undefined);
  const ready = channel.available && channel.loaded;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    send("cost.read", {}).then(
      (result) => {
        if (!cancelled) setData(result.data ?? null);
        return undefined;
      },
      (error: unknown) => {
        // An older forge has no cost.read: the footer's cost is what the line shows.
        if (!cancelled && isRemoteError(error)) setData(null);
        else if (!cancelled) setData(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ready, send]);
  const rows: CostRow[] = data === undefined ? [] : costRows(data, footer);
  let body;
  if (!channel.available) body = <UpdateForge />;
  else if (data === undefined) body = <Loading />;
  else if (rows.length === 0) body = <UpdateForge />;
  else
    body = (
      <ScrollView contentContainerStyle={forgeStyles.scroll} testID="cost-rows">
        {rows.map((row) => (
          <View
            key={row.label}
            style={styles.costRow}
            accessible
            accessibilityLabel={`${row.label}, ${row.value}`}
          >
            <Text style={styles.label}>{row.label}</Text>
            <Text style={styles.value}>{row.value}</Text>
          </View>
        ))}
      </ScrollView>
    );
  return <ForgeFrame title={t("pi.forge.titles.cost")}>{body}</ForgeFrame>;
}

export function ChangelogView({ channel }: ForgeViewProps) {
  const { t } = useTranslation();
  const action = useForgeAction(channel);
  const run = action.run;
  const [markdown, setMarkdown] = useState<string | null>(null);
  const ready = channel.available && channel.loaded;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void run("changelog.read", {}).then((out) => {
      if (!cancelled && out.ok) setMarkdown(changelogMarkdown(out.data));
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [ready, run]);
  let body;
  if (!channel.available || action.unsupported) body = <UpdateForge />;
  else if (markdown === null) body = action.error ? null : <Loading />;
  else
    body = (
      <ScrollView contentContainerStyle={styles.markdown} testID="changelog">
        <TranscriptProviders>
          <MarkdownRenderer text={markdown || t("pi.forge.changelog.empty")} />
        </TranscriptProviders>
      </ScrollView>
    );
  return (
    <ForgeFrame title={t("pi.forge.titles.changelog")}>
      {body}
      <ErrorLine message={action.error} onDismiss={action.clearError} />
    </ForgeFrame>
  );
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
  heading: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "600" },
  meter: { gap: theme.spacing[1], paddingTop: theme.spacing[1] },
  meterHead: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[3] },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  value: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
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
  markdown: { paddingHorizontal: theme.spacing[4], paddingVertical: theme.spacing[3] },
}));

const MIN_ROW = 48;
