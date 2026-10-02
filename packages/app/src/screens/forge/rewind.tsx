// /rewind: the prompts on this branch as the CLI lists them (each with what going back would undo,
// from rewind.preview), then its four choices. Restoring is destructive, so it asks once more.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ConfirmSheet } from "@/components/pi/confirm-sheet";
import { isRemoteError } from "@/remote/errors";
import {
  parseRewindPreview,
  REWIND_CHOICES,
  rewindLine,
  rewindPrompts,
  type RewindMode,
  type RewindPrompt,
} from "@/remote/views";
import { useChatFeed } from "@/screens/session/use-chat-feed";
import { handBack } from "./draft-store";
import type { ForgeViewProps } from "./forge-screen";
import {
  backToSession,
  ErrorLine,
  ForgeFrame,
  forgeStyles,
  ListRow,
  Loading,
  UpdateForge,
  useForgeAction,
} from "./parts";

const keyOf = (p: RewindPrompt) => p.entryId;

export function RewindView({ hostId, row, channel, active }: ForgeViewProps) {
  const { t } = useTranslation();
  const feed = useChatFeed(hostId, row, active);
  const prompts = useMemo(() => rewindPrompts(feed.rows), [feed.rows]);
  const previews = usePreviews(channel, prompts, channel.state?.checkpoints !== undefined);
  const [picked, setPicked] = useState<RewindPrompt | null>(null);
  const action = useForgeAction(channel);
  const [mode, setMode] = useState<RewindMode | null>(null);

  const apply = useCallback(async () => {
    if (!picked || !mode) return;
    setMode(null);
    const out = await action.run("rewind.apply", { entryId: picked.entryId, mode });
    if (!out.ok) return;
    if (mode !== "code") handBack(row.sessionId, picked.text);
    backToSession(hostId, row.sessionId);
  }, [action, hostId, mode, picked, row.sessionId]);
  const cancelSheet = useCallback(() => setMode(null), []);
  const pickChoice = useCallback((choice: string) => {
    if (choice === "cancel") setPicked(null);
    else setMode(choice as RewindMode);
  }, []);
  const pickPrompt = useCallback(
    (entryId: string) => setPicked(prompts.find((p) => p.entryId === entryId) ?? null),
    [prompts],
  );
  const lines = previews.lines;
  const renderPrompt = useCallback(
    ({ item }: { item: RewindPrompt }) => (
      <ListRow
        title={item.text}
        subtitle={lines[item.entryId] ?? "…"}
        pressKey={item.entryId}
        onPressKey={pickPrompt}
        testID={`rewind-row-${item.entryId}`}
      />
    ),
    [lines, pickPrompt],
  );
  const listHeader = useMemo(
    () => <Text style={forgeStyles.intro}>{t("pi.forge.rewind.intro")}</Text>,
    [t],
  );

  let body;
  if (!channel.available || (channel.loaded && channel.state?.checkpoints === undefined))
    body = <UpdateForge />;
  else if (action.unsupported || previews.unsupported) body = <UpdateForge />;
  else if (!channel.loaded || feed.loading) body = <Loading />;
  else if (picked)
    body = (
      <ScrollView contentContainerStyle={forgeStyles.scroll}>
        <Text style={forgeStyles.intro}>{t("pi.forge.rewind.confirmIntro")}</Text>
        <View style={styles.quote}>
          <Text style={styles.quoteText} numberOfLines={6} testID="rewind-quote">
            {picked.text}
          </Text>
        </View>
        {REWIND_CHOICES.map((choice) => (
          <ListRow
            key={choice}
            title={t(`pi.forge.rewind.choice.${choice}`)}
            pressKey={choice}
            onPressKey={pickChoice}
            testID={`rewind-choice-${choice}`}
          />
        ))}
        <ErrorLine message={action.error} onDismiss={action.clearError} />
      </ScrollView>
    );
  else if (prompts.length === 0)
    body = <Text style={forgeStyles.intro}>{t("pi.forge.rewind.empty")}</Text>;
  else
    body = (
      <FlatList
        data={prompts}
        keyExtractor={keyOf}
        ListHeaderComponent={listHeader}
        renderItem={renderPrompt}
        testID="rewind-list"
      />
    );

  return (
    <ForgeFrame title={t("pi.forge.titles.rewind")}>
      {body}
      <ConfirmSheet
        visible={mode !== null}
        title={t("pi.forge.rewind.confirmTitle")}
        body={mode ? t(`pi.forge.rewind.confirmBody.${mode}`) : ""}
        cancelLabel={t("pi.forge.cancel")}
        confirmLabel={t("pi.forge.rewind.confirm")}
        onConfirm={apply}
        onCancel={cancelSheet}
        testID="rewind-sheet"
      />
    </ForgeFrame>
  );
}

/** rewind.preview for each prompt, one at a time (each is an inbox round trip), kept per entry. */
function usePreviews(
  channel: ForgeViewProps["channel"],
  prompts: readonly RewindPrompt[],
  enabled: boolean,
) {
  const [lines, setLines] = useState<Record<string, string>>({});
  const [unsupported, setUnsupported] = useState(false);
  const asked = useRef(new Set<string>());
  const send = channel.send;
  const ids = prompts.map((p) => p.entryId).join("\n");
  useEffect(() => {
    if (!enabled || !ids) return undefined;
    let cancelled = false;
    void (async () => {
      // Newest first: the rows nearest "now" are the ones most often rewound to.
      const list = ids.split("\n");
      for (let i = list.length - 1; i >= 0; i--) {
        const entryId = list[i];
        if (cancelled) return;
        if (asked.current.has(entryId)) continue;
        asked.current.add(entryId);
        try {
          const result = await send("rewind.preview", { entryId });
          const preview = parseRewindPreview(result.data);
          if (preview && !cancelled)
            setLines((prev) => ({ ...prev, [entryId]: rewindLine(preview) }));
        } catch (error) {
          if (isRemoteError(error, "unknown-action")) {
            if (!cancelled) setUnsupported(true);
            return;
          }
          asked.current.delete(entryId);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, ids, send]);
  return { lines, unsupported };
}

const styles = StyleSheet.create((theme) => ({
  quote: {
    marginHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[3],
    paddingLeft: theme.spacing[3],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
  },
  quoteText: { color: theme.colors.foreground, fontSize: theme.fontSize.base, lineHeight: 21 },
}));
