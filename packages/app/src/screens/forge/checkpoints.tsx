// /diff and /restore: this session's checkpoints (newest first, as the CLI's completion lists them),
// a checkpoint's patch against the working tree (monospace, horizontal scroll, tinted +/-), and a
// restore behind a confirm.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ConfirmSheet } from "@/components/pi/confirm-sheet";
import { Button } from "@/components/ui/button";
import type { RemoteCheckpoint } from "@/remote/types";
import {
  agoText,
  checkpointChange,
  checkpointsNewestFirst,
  diffLines,
  parseCheckpointDiff,
  type CheckpointDiff,
  type DiffLine,
} from "@/remote/views";
import type { ForgeViewProps } from "./forge-screen";
import {
  backToSession,
  ErrorLine,
  ForgeFrame,
  forgeStyles,
  ListRow,
  Loading,
  openForge,
  UpdateForge,
  useForgeAction,
} from "./parts";

const keyOf = (cp: RemoteCheckpoint) => String(cp.n);

export function CheckpointsView({ hostId, row, channel }: ForgeViewProps) {
  const { t } = useTranslation();
  const list = channel.state?.checkpoints;
  const rows = useMemo(() => (list ? checkpointsNewestFirst(list) : []), [list]);
  const sessionId = row.sessionId;
  const openDiff = useCallback(
    (n: string) => openForge(hostId, sessionId, "diff", { n }),
    [hostId, sessionId],
  );
  const renderCheckpoint = useCallback(
    ({ item }: { item: RemoteCheckpoint }) => (
      <ListRow
        title={`${item.n}: ${item.label || t("pi.forge.checkpoints.untitled")}`}
        subtitle={`${checkpointChange(item)} · ${agoText(item.at, Date.now())}`}
        pressKey={String(item.n)}
        onPressKey={openDiff}
        testID={`checkpoint-row-${item.n}`}
      />
    ),
    [openDiff, t],
  );
  let body;
  if (!channel.available || (channel.loaded && list === undefined)) body = <UpdateForge />;
  else if (!channel.loaded) body = <Loading />;
  else if (rows.length === 0)
    body = <Text style={forgeStyles.intro}>{t("pi.forge.checkpoints.empty")}</Text>;
  else
    body = (
      <FlatList
        data={rows}
        keyExtractor={keyOf}
        renderItem={renderCheckpoint}
        testID="checkpoints-list"
      />
    );
  return <ForgeFrame title={t("pi.forge.titles.checkpoints")}>{body}</ForgeFrame>;
}

export function DiffView({ hostId, row, channel, params }: ForgeViewProps) {
  const { t } = useTranslation();
  const n = Number(params.n);
  const checkpoint = channel.state?.checkpoints?.find((cp) => cp.n === n);
  const action = useForgeAction(channel);
  const run = action.run;
  const [diff, setDiff] = useState<CheckpointDiff | null>(null);
  const [confirm, setConfirm] = useState(false);
  const ready = channel.available && channel.loaded;

  useEffect(() => {
    if (!ready || !Number.isFinite(n)) return;
    let cancelled = false;
    void run("checkpoint.diff", { n }).then((out) => {
      if (!cancelled && out.ok)
        setDiff(parseCheckpointDiff(out.data) ?? { patch: "", truncated: false });
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [n, ready, run]);

  const restore = useCallback(async () => {
    setConfirm(false);
    const out = await run("checkpoint.restore", { n });
    if (out.ok) backToSession(hostId, row.sessionId);
  }, [hostId, n, row.sessionId, run]);
  const close = useCallback(() => setConfirm(false), []);
  const ask = useCallback(() => setConfirm(true), []);

  let body;
  if (!channel.available || action.unsupported) body = <UpdateForge />;
  else if (!diff) body = action.error ? null : <Loading testID="diff-loading" />;
  else body = <PatchView diff={diff} />;

  return (
    <ForgeFrame title={t("pi.forge.titles.diff", { n: String(n) })}>
      {checkpoint ? (
        <Text style={forgeStyles.intro} numberOfLines={2}>
          {`${checkpoint.label || t("pi.forge.checkpoints.untitled")} · ${checkpointChange(checkpoint)}`}
        </Text>
      ) : null}
      <View style={styles.fill}>{body}</View>
      <ErrorLine message={action.error} onDismiss={action.clearError} />
      {diff && !action.unsupported ? (
        <View style={forgeStyles.footer}>
          <Button
            variant="destructive"
            onPress={ask}
            loading={action.busy === "checkpoint.restore"}
            style={styles.fill}
            testID="checkpoint-restore"
          >
            {t("pi.forge.checkpoints.restore")}
          </Button>
        </View>
      ) : null}
      <ConfirmSheet
        visible={confirm}
        title={t("pi.forge.checkpoints.restoreTitle", { n: String(n) })}
        body={t("pi.forge.checkpoints.restoreBody")}
        cancelLabel={t("pi.forge.cancel")}
        confirmLabel={t("pi.forge.checkpoints.restore")}
        onConfirm={restore}
        onCancel={close}
        testID="restore-sheet"
      />
    </ForgeFrame>
  );
}

function PatchView({ diff }: { diff: CheckpointDiff }) {
  const { t } = useTranslation();
  const { lines, cut } = useMemo(() => diffLines(diff.patch), [diff.patch]);
  if (lines.length === 0)
    return <Text style={forgeStyles.intro}>{t("pi.forge.checkpoints.noChanges")}</Text>;
  return (
    <ScrollView contentContainerStyle={forgeStyles.scroll} testID="diff-scroll">
      {diff.truncated || cut ? (
        <Text style={forgeStyles.intro} testID="diff-truncated">
          {t("pi.forge.checkpoints.truncated")}
        </Text>
      ) : null}
      <ScrollView horizontal contentContainerStyle={styles.hscroll} testID="diff-view">
        <View style={styles.lines}>
          {lines.map((line) => (
            <PatchLine key={line.at} line={line} />
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

function PatchLine({ line }: { line: DiffLine }) {
  return (
    <Text
      style={[
        styles.line,
        line.kind === "add" && styles.add,
        line.kind === "del" && styles.del,
        line.kind === "hunk" && styles.hunk,
        line.kind === "file" && styles.file,
      ]}
    >
      {line.text || " "}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1 },
  hscroll: { minWidth: "100%" },
  lines: { alignItems: "stretch", paddingVertical: theme.spacing[2] },
  line: {
    paddingHorizontal: theme.spacing[4],
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  add: { color: theme.colors.diffAddition, backgroundColor: theme.colors.statusSuccessTint },
  del: { color: theme.colors.diffDeletion, backgroundColor: theme.colors.statusDangerTint },
  hunk: { color: theme.colors.foregroundMuted },
  file: { color: theme.colors.foregroundMuted, fontWeight: "600" },
}));
