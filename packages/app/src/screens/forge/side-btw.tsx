// /side: a second conversation on this session, read from its own session file and written to
// with side.send, clearly marked as the side. /btw: a quick question whose answers come from the
// session's hidden forge-btw entries (history since the last clear), with fork and clear.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChatView } from "@/components/pi/chat-view";
import { Composer } from "@/components/pi/composer";
import { ConfirmSheet } from "@/components/pi/confirm-sheet";
import { MutedSpinner } from "@/components/pi/icons";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { connectionRunner } from "@/remote/client";
import { readBtwHistory } from "@/remote/session-file";
import type { RemoteBtw } from "@/remote/types";
import type { BtwExchange } from "@/remote/views";
import { useChatFeed } from "@/screens/session/use-chat-feed";
import { connectionStore } from "@/stores/app";
import { usePoller } from "@/stores/use-polling";
import type { ForgeViewProps } from "./forge-screen";
import {
  ErrorLine,
  ForgeFrame,
  forgeStyles,
  Loading,
  openForge,
  TranscriptProviders,
  UpdateForge,
  useForgeAction,
} from "./parts";

export function SideView({ hostId, channel, active, params }: ForgeViewProps) {
  const { t } = useTranslation();
  const side = channel.state?.side;
  const action = useForgeAction(channel);
  const run = action.run;
  const open = Boolean(side?.open && side.sessionFile);
  const sideFile = side?.sessionFile ?? undefined;
  const working = side?.working === true;
  const source = useMemo(
    () =>
      open
        ? { sessionFile: sideFile, state: working ? ("working" as const) : ("idle" as const) }
        : undefined,
    [open, sideFile, working],
  );
  const feed = useChatFeed(hostId, source, active && open);
  const seed = useRef(params.arg ?? "");
  const boost = feed.boost;

  const send = useCallback(
    async (text: string) => {
      const out = await run(open ? "side.send" : "side.open", { text });
      if (out.ok) boost();
      return out.ok;
    },
    [boost, open, run],
  );
  const close = useCallback(() => void run("side.close", {}), [run]);
  const absent = side === undefined;
  // `/side words`: open it with them, once.
  useEffect(() => {
    if (!channel.loaded || absent || open || !seed.current) return;
    const text = seed.current;
    seed.current = "";
    void run("side.open", { text });
  }, [absent, channel.loaded, open, run]);

  const closing = action.busy === "side.close";
  const right = useMemo(
    () =>
      open ? (
        <Button variant="ghost" onPress={close} loading={closing} testID="side-close">
          {t("pi.forge.side.close")}
        </Button>
      ) : null,
    [close, closing, open, t],
  );
  const unavailable = !channel.available || action.unsupported || (channel.loaded && absent);
  const ready = !unavailable && channel.loaded;
  return (
    <ForgeFrame title={t("pi.forge.titles.side")} right={right}>
      <View style={styles.badgeRow}>
        <Text style={styles.badge} testID="side-badge">
          {t("pi.forge.side.badge")}
        </Text>
      </View>
      <SideBody unavailable={unavailable} loaded={channel.loaded} open={open} feed={feed} />
      <ErrorLine message={action.error} onDismiss={action.clearError} />
      {ready ? (
        <Composer
          placeholder={t(open ? "pi.forge.side.placeholder" : "pi.forge.side.openPlaceholder")}
          onSubmit={send}
          busy={action.busy !== null}
          testID="side-composer"
          sendTestID="side-send"
        />
      ) : null}
    </ForgeFrame>
  );
}

function SideBody({
  unavailable,
  loaded,
  open,
  feed,
}: {
  unavailable: boolean;
  loaded: boolean;
  open: boolean;
  feed: ReturnType<typeof useChatFeed>;
}) {
  const { t } = useTranslation();
  if (unavailable) return <UpdateForge />;
  if (!loaded) return <Loading />;
  if (!open)
    return (
      <View style={styles.fill}>
        <Text style={forgeStyles.intro}>{t("pi.forge.side.empty")}</Text>
      </View>
    );
  return (
    <TranscriptProviders>
      <ChatView rows={feed.rows} truncated={feed.truncated} loading={feed.loading} />
    </TranscriptProviders>
  );
}

export function BtwView({ hostId, row, channel, active, params }: ForgeViewProps) {
  const { t } = useTranslation();
  const action = useForgeAction(channel);
  const run = action.run;
  const [history, setHistory] = useState<BtwExchange[] | null>(null);
  const [pending, setPending] = useState<{ question: string; seen: number } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const sessionFile = row.sessionFile;
  const seed = useRef(params.arg ?? "");
  const { btw, known, remotePending, remoteError, panelOpen } = btwPanel(channel.state?.btw);

  const load = useCallback(async () => {
    const service = connectionStore.getState().getService(hostId);
    if (!service || !sessionFile) return 3000;
    try {
      const next = await readBtwHistory(connectionRunner(service.connection), sessionFile);
      setHistory(next);
      setPending((p) => (p && next.length > p.seen ? null : p));
    } catch {
      return 3000;
    }
    return 1500;
  }, [hostId, sessionFile]);
  const kick = usePoller(load, 1500, active && channel.available);

  const ask = useCallback(
    async (text: string) => {
      const seen = history?.length ?? 0;
      setPending({ question: text, seen });
      const out = await run("btw.ask", { text });
      if (!out.ok) setPending(null);
      kick();
      return out.ok;
    },
    [history, kick, run],
  );
  // forge says the answer is no longer coming (answered or failed): the local echo goes.
  useEffect(() => {
    if (known && !remotePending && (remoteError || !btw?.question)) setPending(null);
  }, [btw?.question, known, remoteError, remotePending]);
  const closePanel = useCallback(() => void run("btw.close", {}), [run]);
  const right = useMemo(
    () =>
      panelOpen ? (
        <Button
          variant="ghost"
          onPress={closePanel}
          loading={action.busy === "btw.close"}
          testID="btw-close"
        >
          {t("pi.forge.btw.close")}
        </Button>
      ) : null,
    [action.busy, closePanel, panelOpen, t],
  );
  useEffect(() => {
    if (!channel.loaded || history === null || !seed.current) return;
    const text = seed.current;
    seed.current = "";
    void ask(text);
  }, [ask, channel.loaded, history]);

  const fork = useCallback(async () => {
    const out = await run("btw.fork", {});
    if (out.ok) openForge(hostId, row.sessionId, "side", {}, true);
  }, [hostId, row.sessionId, run]);
  const clear = useCallback(async () => {
    setConfirmClear(false);
    const out = await run("btw.clear", {});
    if (out.ok) kick();
  }, [kick, run]);
  const askClear = useCallback(() => setConfirmClear(true), []);
  const cancelClear = useCallback(() => setConfirmClear(false), []);

  const pendingQuestion = shownPending(remotePending, btw?.question ?? null, pending?.question);
  const body =
    !channel.available || action.unsupported ? (
      <UpdateForge />
    ) : (
      <BtwBody
        history={history}
        pendingQuestion={pendingQuestion}
        error={remoteError}
        errorQuestion={btw?.question ?? null}
      />
    );
  const hasAnswers = (history?.length ?? 0) > 0;
  return (
    <ForgeFrame title={t("pi.forge.titles.btw")} right={right}>
      {body}
      <ErrorLine message={action.error} onDismiss={action.clearError} />
      {channel.available && !action.unsupported ? (
        <>
          {hasAnswers ? (
            <BtwActions
              busy={action.busy}
              onClear={askClear}
              onFork={fork}
              clearLabel={t("pi.forge.btw.clear")}
              forkLabel={t("pi.forge.btw.fork")}
            />
          ) : null}
          <View style={styles.composer}>
            <Composer
              placeholder={t("pi.forge.btw.placeholder")}
              onSubmit={ask}
              busy={action.busy === "btw.ask" || pendingQuestion !== null}
              testID="btw-composer"
              sendTestID="btw-send"
            />
          </View>
        </>
      ) : null}
      <ConfirmSheet
        visible={confirmClear}
        title={t("pi.forge.btw.clearTitle")}
        body={t("pi.forge.btw.clearBody")}
        cancelLabel={t("pi.forge.cancel")}
        confirmLabel={t("pi.forge.btw.clear")}
        onConfirm={clear}
        onCancel={cancelClear}
        testID="btw-clear-sheet"
      />
    </ForgeFrame>
  );
}

/** forge's /btw panel (v1.2); undefined on a build without it (then the app's own pending). */
function btwPanel(btw: RemoteBtw | null | undefined) {
  const known = btw !== undefined;
  return {
    btw: btw ?? null,
    known,
    remotePending: known && btw?.pending === true,
    remoteError: known ? (btw?.error ?? null) : null,
    panelOpen: known && btw?.open === true,
  };
}

/** The question whose answer is still coming: forge's while it says so, else the app's own echo. */
function shownPending(
  remotePending: boolean,
  remoteQuestion: string | null,
  local: string | undefined,
): string | null {
  if (remotePending) return remoteQuestion ?? local ?? "";
  return local ?? null;
}

/** The answers since the last clear, then the one still coming, or why the last one failed. */
function BtwBody({
  history,
  pendingQuestion,
  error,
  errorQuestion,
}: {
  history: BtwExchange[] | null;
  pendingQuestion: string | null;
  error: string | null;
  errorQuestion: string | null;
}) {
  const { t } = useTranslation();
  // Position is the exchange's identity (the history is append-only between clears).
  const keyed = useMemo(
    () => (history ?? []).map((exchange, index) => ({ exchange, id: String(index) })),
    [history],
  );
  if (history === null) return <Loading />;
  const showError = Boolean(error) && !pendingQuestion;
  return (
    <ScrollView contentContainerStyle={forgeStyles.scroll} testID="btw-history">
      {history.length === 0 && !pendingQuestion && !error ? (
        <Text style={forgeStyles.intro}>{t("pi.forge.btw.empty")}</Text>
      ) : null}
      <TranscriptProviders>
        {keyed.map(({ exchange: item, id }) => (
          <View key={id} style={styles.exchange} testID={`btw-item-${id}`}>
            <Text style={styles.question}>{item.question}</Text>
            <MarkdownRenderer text={item.answer} />
            {item.note ? <Text style={forgeStyles.muted}>{item.note}</Text> : null}
          </View>
        ))}
      </TranscriptProviders>
      {pendingQuestion ? (
        <View style={styles.exchange} testID="btw-pending">
          <Text style={styles.question}>{pendingQuestion}</Text>
          <MutedSpinner size="small" />
        </View>
      ) : null}
      {showError ? (
        <View style={styles.exchange} testID="btw-error">
          {errorQuestion ? <Text style={styles.question}>{errorQuestion}</Text> : null}
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

function BtwActions({
  busy,
  onClear,
  onFork,
  clearLabel,
  forkLabel,
}: {
  busy: string | null;
  onClear: () => void;
  onFork: () => void;
  clearLabel: string;
  forkLabel: string;
}) {
  return (
    <View style={styles.actions}>
      <Button
        variant="ghost"
        onPress={onClear}
        loading={busy === "btw.clear"}
        style={styles.fill}
        testID="btw-clear"
      >
        {clearLabel}
      </Button>
      <Button
        variant="secondary"
        onPress={onFork}
        loading={busy === "btw.fork"}
        style={styles.fill}
        testID="btw-fork"
      >
        {forkLabel}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1 },
  composer: {},
  badgeRow: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  badge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    overflow: "hidden",
  },
  exchange: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  question: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "600" },
  errorText: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
}));
