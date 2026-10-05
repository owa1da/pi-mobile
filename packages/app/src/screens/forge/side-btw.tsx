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
import { SheetActions, sheetActionStyles } from "@/components/pi/sheet-actions";
import { SessionGlyph } from "@/components/pi/session-glyph";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { connectionRunner } from "@/remote/client";
import { readBtwHistory } from "@/remote/session-file";
import { RemoteError } from "@/remote/errors";
import type { RemoteChannel } from "@/screens/session/use-remote-channel";
import type { RemoteBtw } from "@/remote/types";
import { modelErrorKey, type BtwExchange } from "@/remote/views";
import { useChatFeed } from "@/screens/session/use-chat-feed";
import { connectionStore } from "@/stores/app";
import { usePoller } from "@/stores/use-polling";
import type { ForgeViewProps } from "./forge-screen";
import { useSideNavigation } from "./use-side-navigation";
import { sideRouteParams } from "./side-route";
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

export function SideView({ hostId, row, channel, active, params }: ForgeViewProps) {
  const { t } = useTranslation();
  const side = channel.state?.side;
  const sideFile = side?.sessionFile ?? undefined;
  const navigation = useSideNavigation(
    hostId,
    row,
    channel,
    params.sideEntry,
    params.sideId,
    params.sideGen,
  );
  const created = navigation.created;
  const readState = channel.read;
  const sendRemote = channel.send;
  const sendAction = useCallback<RemoteChannel["send"]>(
    async (name, args) => {
      const fresh = await readState();
      if (
        !fresh ||
        fresh.pid !== row.pid ||
        fresh.sessionId !== row.sessionId ||
        (fresh.side?.sessionFile ?? undefined) !== sideFile
      )
        throw new RemoteError("stale");
      const result = await sendRemote(name, args, { rev: fresh.rev, sessionId: row.sessionId });
      if (name === "side.open") {
        // Capture creation ownership before waiting for a transcript (which may not exist yet).
        created(result?.data);
        const opened = await readState();
        if (opened?.pid === row.pid && opened.sessionId === row.sessionId && opened.side)
          created(undefined, opened.side);
      }
      return result;
    },
    [created, readState, row.pid, row.sessionId, sendRemote, sideFile],
  );
  const action = useForgeAction({ ...channel, send: sendAction });
  const run = action.run;
  // `open` is terminal visibility; a hidden side still exists and owns its transcript/composer.
  const exists = side != null;
  const working = side?.working === true;
  const source = useMemo(
    () =>
      exists
        ? { sessionFile: sideFile, state: working ? ("working" as const) : ("idle" as const) }
        : undefined,
    [exists, sideFile, working],
  );
  const feed = useChatFeed(hostId, source, active && exists);
  const boost = feed.boost;
  const perform = navigation.perform;
  const markClosed = navigation.closed;
  const send = useCallback(
    (text: string) =>
      perform(async () => {
        const out = await run(exists ? "side.send" : "side.open", { text });
        if (out.ok) boost();
        return out.ok;
      }, false),
    [boost, exists, perform, run],
  );
  const close = useCallback(
    () =>
      perform(async () => {
        const out = await run("side.close", {});
        if (out.ok) markClosed();
      }, undefined),
    [markClosed, perform, run],
  );
  const absent = side === undefined;
  // /side's replacement/text ran before navigation. Mounts and polling never create or send.

  const clearActionError = action.clearError;
  const clearNavigationError = navigation.clearError;
  const clearError = useCallback(() => {
    clearActionError();
    clearNavigationError();
  }, [clearActionError, clearNavigationError]);
  const closing = action.busy === "side.close";
  const right = useMemo(
    () =>
      exists ? (
        <Button variant="ghost" onPress={close} loading={closing} testID="side-close">
          {t("pi.forge.side.close")}
        </Button>
      ) : null,
    [close, closing, exists, t],
  );
  const unavailable = !channel.available || action.unsupported || (channel.loaded && absent);
  const ready = !unavailable && channel.loaded;
  return (
    <ForgeFrame title={t("pi.forge.titles.side")} right={right}>
      <SideBody unavailable={unavailable} loaded={channel.loaded} open={exists} feed={feed} />
      <ErrorLine message={action.error ?? navigation.error} onDismiss={clearError} />
      {ready ? (
        <Composer
          placeholder={t(exists ? "pi.forge.side.placeholder" : "pi.forge.side.openPlaceholder")}
          onSubmit={send}
          busy={action.busy !== null}
          autoFocus={!exists || feed.rows.length === 0}
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
  if (unavailable) return <UpdateForge />;
  if (!loaded) return <Loading />;
  // forge's side draws nothing before its first message: the input's placeholder says it.
  if (!open || (!feed.loading && feed.rows.length === 0))
    return <View style={styles.fill} testID="side-empty" />;
  return (
    <TranscriptProviders>
      <ChatView rows={feed.rows} loading={feed.loading} />
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
  // forge's panel has one way out (Esc to close): here it is leaving the screen, by the header's
  // arrow or the system back, which closes forge's panel as Esc does.
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  const sendRef = useRef(channel.send);
  sendRef.current = channel.send;
  useEffect(
    () => () => {
      if (panelOpenRef.current) void sendRef.current("btw.close", {}).catch(() => undefined);
    },
    [],
  );
  useEffect(() => {
    if (!channel.loaded || history === null || !seed.current) return;
    const text = seed.current;
    seed.current = "";
    void ask(text);
  }, [ask, channel.loaded, history]);

  const fork = useCallback(async () => {
    const out = await run("btw.fork", {});
    if (!out.ok) return;
    // forge closed its panel with the fork: leaving for the side sends no second close.
    panelOpenRef.current = false;
    openForge(hostId, row.sessionId, "side", sideRouteParams(out.data), true);
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
    <ForgeFrame title={t("pi.forge.titles.btw")}>
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
  // pi's raw provider text ("Unknown provider: unknown") in plain words; other text as forge says it.
  const errorKey = error ? modelErrorKey(error) : null;
  const plainError = errorKey ? t(`pi.forge.modelErrors.${errorKey}`) : error;
  return (
    <ScrollView contentContainerStyle={forgeStyles.scroll} testID="btw-history">
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
          {/* forge's `✻ Answering…` from the first frame until the answer's first text. */}
          <View style={styles.pendingLine}>
            <SessionGlyph kind="working" />
            <Text style={styles.pendingText}>{t("pi.forge.btw.answering")}</Text>
          </View>
        </View>
      ) : null}
      {showError ? (
        <View style={styles.exchange} testID="btw-error">
          {errorQuestion ? <Text style={styles.question}>{errorQuestion}</Text> : null}
          <Text style={styles.errorText}>{plainError}</Text>
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
      <SheetActions>
        <Button
          variant="ghost"
          onPress={onClear}
          loading={busy === "btw.clear"}
          style={sheetActionStyles.button}
          testID="btw-clear"
        >
          {clearLabel}
        </Button>
        <Button
          variant="default"
          onPress={onFork}
          loading={busy === "btw.fork"}
          style={sheetActionStyles.button}
          testID="btw-fork"
        >
          {forkLabel}
        </Button>
      </SheetActions>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1 },
  composer: {},
  exchange: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  question: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "600" },
  errorText: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  pendingLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  pendingText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
}));
