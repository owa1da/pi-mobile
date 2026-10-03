// The smaller forge commands as sheets over the session, in the sheet grammar (title, one body,
// SheetActions with the secondary first): /pause (wake-up), /export, /rename, /branch, /clear, /sync.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Keyboard, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SheetActions, sheetActionStyles } from "@/components/pi/sheet-actions";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { SessionRow } from "@/host/types";
import { hostNow } from "@/remote/for-service";
import { connectionStore } from "@/stores/app";
import { isRemoteError } from "@/remote/errors";
import type { NativeTool } from "@/remote/menu";
import type { RemoteWake } from "@/remote/types";
import {
  exportedPath,
  exportNeedsOverwrite,
  parseSyncStatus,
  sessionName,
  syncDone,
  wakeArgs,
  wakeWhen,
} from "@/remote/views";
import type { RemoteChannel } from "@/screens/session/use-remote-channel";
import { useForgeAction } from "./parts";
import { FIELD_SHEETS } from "./sheet-layout";

export type SheetTool = Extract<
  NativeTool,
  "pause" | "export" | "rename" | "branch" | "clear" | "sync"
>;

export interface OpenSheet {
  kind: SheetTool;
  arg: string;
}

interface SheetsProps {
  hostId: string;
  row: SessionRow;
  channel: RemoteChannel;
  sheet: OpenSheet | null;
  onClose: () => void;
  /** /clear and /branch put a new session in this pi process: follow it. */
  onReplaced: (pid: number) => void;
}

/**
 * One modal, always mounted (remounting a bottom-sheet modal mid-transition is unreliable); each
 * open (kind or arg) resets its fields, and the last sheet stays drawn while it slides away.
 */
export function SessionSheets(props: SheetsProps) {
  const last = useRef<OpenSheet | null>(null);
  const opens = useRef(0);
  const prev = useRef<OpenSheet | null>(null);
  if (props.sheet && props.sheet !== prev.current) opens.current += 1;
  prev.current = props.sheet;
  if (props.sheet) last.current = props.sheet;
  return <SheetBody {...props} shown={last.current} openId={opens.current} />;
}

type Run = ReturnType<typeof useForgeAction>["run"];

/** Everything a sheet's submit reads and sets. */
interface SubmitContext {
  run: Run;
  t: TFunction;
  text: string;
  reason: string;
  mode: "in" | "at";
  overwrite: boolean;
  pid: number;
  onClose: () => void;
  onReplaced: (pid: number) => void;
  setFieldError: (error: string | null) => void;
  setResult: (result: string | null) => void;
  setResultError: (error: boolean) => void;
  setOverwrite: (on: boolean) => void;
}

const SUBMIT: Record<SheetTool, (c: SubmitContext) => Promise<void>> = {
  async pause(c) {
    const checked = wakeArgs(c.mode, c.text, c.reason, new Date());
    if (!checked.ok) {
      c.setFieldError(c.t(`pi.forge.pause.errors.${checked.error}`));
      return;
    }
    if ((await c.run("wake.set", checked.args)).ok) c.onClose();
  },
  async export(c) {
    const path = c.text.trim();
    const args = { ...(path ? { path } : {}), ...(c.overwrite ? { overwrite: true } : {}) };
    const out = await c.run("export.run", args, ["refused"]);
    if (out.ok) {
      c.setResult(exportedPath(out.data) ?? path);
      return;
    }
    const err = out.error;
    if (!isRemoteError(err, "refused")) return;
    if (exportNeedsOverwrite(err.reason)) c.setOverwrite(true);
    else c.setFieldError(err.detail ?? c.t("pi.remote.errors.refused"));
  },
  async rename(c) {
    const name = sessionName(c.text);
    if (!name) {
      c.setFieldError(c.t("pi.forge.rename.required"));
      return;
    }
    if ((await c.run("session.rename", { name })).ok) c.onClose();
  },
  async branch(c) {
    const name = sessionName(c.text);
    if (!(await c.run("session.branch", name ? { name } : {})).ok) return;
    c.onClose();
    c.onReplaced(c.pid);
  },
  async clear(c) {
    if (!(await c.run("session.clear", {})).ok) return;
    c.onClose();
    c.onReplaced(c.pid);
  },
  async sync(c) {
    const out = await c.run("sync.run", {});
    if (!out.ok) return;
    c.setResultError(false);
    // done=false: setup still runs on the computer; pi reloads when it finishes.
    c.setResult(c.t(syncDone(out.data) ? "pi.forge.sync.done" : "pi.forge.sync.running"));
  },
};

function initialText(sheet: OpenSheet | null, row: SessionRow): string {
  if (!sheet) return "";
  if (sheet.kind === "rename") return sheet.arg || row.title || "";
  return sheet.arg;
}

function SheetBody({
  hostId,
  row,
  channel,
  sheet,
  shown,
  openId,
  onClose,
  onReplaced,
}: SheetsProps & { shown: OpenSheet | null; openId: number }) {
  const { t } = useTranslation();
  const action = useForgeAction(channel);
  const run = action.run;
  const clearActionError = action.clearError;
  const kind = shown?.kind;
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"in" | "at">("in");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [resultError, setResultError] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const rowRef = useRef(row);
  rowRef.current = row;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  /** The pending wake-up when the sheet opens: editing it starts from its message. */
  const wakeRef = useRef(channel.state?.wake);
  wakeRef.current = channel.state?.wake;
  // A new open starts afresh.
  useEffect(() => {
    const opened = shownRef.current;
    setText(initialText(opened, rowRef.current));
    setReason(opened?.kind === "pause" ? (wakeRef.current?.reason ?? "") : "");
    setMode(/[:.]/.test(opened?.arg ?? "") ? "at" : "in");
    setFieldError(null);
    setResult(null);
    setResultError(false);
    setOverwrite(false);
    clearActionError();
  }, [clearActionError, openId]);
  const wake = channel.state?.wake;
  const absentWake = kind === "pause" && channel.loaded && wake === undefined;
  const unavailable = !channel.available || action.unsupported || absentWake;

  // /sync opens on its status.
  const open = sheet !== null;
  useEffect(() => {
    if (!open || kind !== "sync" || !channel.available || !channel.loaded) return;
    void run("sync.status", {}).then((out) => {
      if (!out.ok) return undefined;
      const status = parseSyncStatus(out.data);
      setResultError(status?.level === "error");
      setResult(status?.text || t("pi.forge.sync.clean"));
      return undefined;
    });
  }, [channel.available, channel.loaded, kind, open, openId, run, t]);

  const ctx = useRef<SubmitContext | null>(null);
  ctx.current = {
    run,
    t,
    text,
    reason,
    mode,
    overwrite,
    pid: row.pid ?? 0,
    onClose,
    onReplaced,
    setFieldError,
    setResult,
    setResultError,
    setOverwrite,
  };
  const submit = useCallback(() => {
    const c = ctx.current;
    if (!kind || !c) return;
    setFieldError(null);
    void SUBMIT[kind](c);
  }, [kind]);
  const cancelWake = useCallback(() => {
    void run("wake.cancel", {}).then((out) => {
      if (out.ok) onClose();
      return undefined;
    });
  }, [onClose, run]);
  const changeExport = useCallback((value: string) => {
    setText(value);
    setOverwrite(false);
  }, []);

  const header = useMemo(() => ({ title: kind ? t(`pi.forge.titles.${kind}`) : "" }), [kind, t]);
  const done = kind === "export" && result !== null;
  useKeyboardGoesOnResult(done);
  const footer = useMemo(
    () =>
      kind ? (
        <SheetFooter
          kind={kind}
          finished={unavailable || done}
          busy={action.busy}
          overwrite={overwrite}
          hasWake={Boolean(wake)}
          onClose={onClose}
          onSubmit={submit}
          onCancelWake={cancelWake}
        />
      ) : null,
    [action.busy, cancelWake, done, kind, onClose, overwrite, submit, unavailable, wake],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={sheet !== null}
      onClose={onClose}
      footer={footer}
      fitContent
      expandWithKeyboard={expandsWithKeyboard(kind, done)}
      testID={kind ? `${kind}-sheet` : undefined}
    >
      <View style={styles.body}>
        {unavailable || !kind ? (
          <Text style={styles.text}>{t("pi.remote.errors.unknown-action")}</Text>
        ) : (
          <SheetContent
            key={openId}
            kind={kind}
            text={text}
            onText={kind === "export" ? changeExport : setText}
            onReason={setReason}
            initialReason={kind === "pause" ? (wake?.reason ?? "") : ""}
            mode={mode}
            onMode={setMode}
            wake={wake ?? null}
            fieldError={fieldError}
            now={hostNow(connectionStore.getState().getService(hostId))}
            result={result}
            resultError={resultError}
            overwrite={overwrite}
          />
        )}
        {action.error ? (
          <Text style={styles.error} testID="forge-sheet-error">
            {action.error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

/** A result replaces the form: the keyboard goes, and the fitted sheet settles to the result. */
function useKeyboardGoesOnResult(done: boolean) {
  useEffect(() => {
    if (done) Keyboard.dismiss();
  }, [done]);
}

/** A sheet with a text field rises to 90% with the keyboard; once it shows a result it does not. */
function expandsWithKeyboard(kind: SheetTool | undefined, done: boolean): boolean {
  return Boolean(kind && FIELD_SHEETS.has(kind)) && !done;
}

function SheetFooter({
  kind,
  finished,
  busy,
  overwrite,
  hasWake,
  onClose,
  onSubmit,
  onCancelWake,
}: {
  kind: SheetTool;
  finished: boolean;
  busy: string | null;
  overwrite: boolean;
  hasWake: boolean;
  onClose: () => void;
  onSubmit: () => void;
  onCancelWake: () => void;
}) {
  const { t } = useTranslation();
  if (finished)
    return (
      <SheetActions>
        <Button
          variant="ghost"
          onPress={onClose}
          style={sheetActionStyles.button}
          testID="forge-sheet-close"
        >
          {t("pi.forge.done")}
        </Button>
      </SheetActions>
    );
  const primary =
    kind === "export" && overwrite ? t("pi.forge.export.overwrite") : t(`pi.forge.${kind}.submit`);
  const destructive = kind === "clear" || overwrite;
  return (
    <SheetActions>
      {kind === "pause" && hasWake ? (
        <Button
          variant="ghost"
          onPress={onCancelWake}
          loading={busy === "wake.cancel"}
          style={sheetActionStyles.button}
          testID="pause-cancel-wake"
        >
          {t("pi.forge.pause.cancelWake")}
        </Button>
      ) : (
        <Button
          variant="ghost"
          onPress={onClose}
          style={sheetActionStyles.button}
          testID="forge-sheet-cancel"
        >
          {t("pi.forge.cancel")}
        </Button>
      )}
      <Button
        variant={destructive ? "destructive" : "default"}
        onPress={onSubmit}
        loading={busy !== null && busy !== "wake.cancel"}
        disabled={busy !== null}
        style={sheetActionStyles.button}
        testID="forge-sheet-submit"
      >
        {primary}
      </Button>
    </SheetActions>
  );
}

interface ContentProps {
  kind: SheetTool;
  text: string;
  onText: (value: string) => void;
  onReason: (value: string) => void;
  /** The Message field's text when the sheet opens: the pending wake-up's reason, when editing it. */
  initialReason: string;
  mode: "in" | "at";
  onMode: (mode: "in" | "at") => void;
  wake: RemoteWake | null;
  fieldError: string | null;
  /** The host's clock (epoch ms). */
  now: number;
  result: string | null;
  resultError: boolean;
  overwrite: boolean;
}

function SheetContent(props: ContentProps) {
  const { t } = useTranslation();
  switch (props.kind) {
    case "pause":
      return <PauseBody {...props} />;
    case "export":
      return <ExportBody {...props} />;
    case "rename":
    case "branch":
      return (
        <Field label={t(`pi.forge.${props.kind}.label`)} error={props.fieldError ?? undefined}>
          <FormTextInput
            initialValue={props.text}
            onChangeText={props.onText}
            placeholder={t(`pi.forge.${props.kind}.placeholder`)}
            accessibilityLabel={t(`pi.forge.${props.kind}.label`)}
            testID={`${props.kind}-field`}
          />
        </Field>
      );
    case "clear":
      return <Text style={styles.text}>{t("pi.forge.clear.body")}</Text>;
    case "sync":
      return props.result === null ? (
        <Text style={styles.text}>{t("pi.forge.sync.checking")}</Text>
      ) : (
        <Text
          style={[styles.mono, props.resultError && styles.monoError]}
          selectable
          testID="sync-text"
        >
          {props.result}
        </Text>
      );
    default:
      return null;
  }
}

function PauseBody(props: ContentProps) {
  const { text, onText, onReason, initialReason, mode, onMode, wake, fieldError, now } = props;
  const { t } = useTranslation();
  const options = useMemo(
    () => [
      { value: "in" as const, label: t("pi.forge.pause.in"), testID: "pause-mode-in" },
      { value: "at" as const, label: t("pi.forge.pause.at"), testID: "pause-mode-at" },
    ],
    [t],
  );
  const label = t(mode === "in" ? "pi.forge.pause.minutes" : "pi.forge.pause.time");
  return (
    <>
      {wake ? (
        <Text style={styles.text} testID="pause-current">
          {pendingWake(t, wake, now)}
        </Text>
      ) : null}
      <SegmentedControl options={options} value={mode} onValueChange={onMode} testID="pause-mode" />
      <Field label={label} error={fieldError ?? undefined}>
        <FormTextInput
          key={mode}
          initialValue={mode === "in" && /[:.]/.test(text) ? "" : text}
          onChangeText={onText}
          placeholder={mode === "in" ? "30" : "14:30"}
          keyboardType={mode === "in" ? "number-pad" : "numbers-and-punctuation"}
          accessibilityLabel={label}
          testID="pause-value"
        />
      </Field>
      <Field label={t("pi.forge.pause.reason")}>
        <FormTextInput
          initialValue={initialReason}
          onChangeText={onReason}
          placeholder={t("pi.forge.pause.reasonPlaceholder")}
          accessibilityLabel={t("pi.forge.pause.reason")}
          testID="pause-reason"
        />
      </Field>
    </>
  );
}

function ExportBody({ text, onText, fieldError, result, overwrite }: ContentProps) {
  const { t } = useTranslation();
  if (result !== null)
    return (
      <>
        <Text style={styles.text}>{t("pi.forge.export.done")}</Text>
        <Text style={styles.mono} selectable testID="export-path">
          {result}
        </Text>
      </>
    );
  return (
    <>
      <Field label={t("pi.forge.export.path")} error={fieldError ?? undefined}>
        <FormTextInput
          initialValue={text}
          onChangeText={onText}
          placeholder={t("pi.forge.export.pathPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("pi.forge.export.path")}
          testID="export-path-field"
        />
      </Field>
      {overwrite ? (
        <Text style={styles.text} testID="export-exists">
          {t("pi.forge.export.exists")}
        </Text>
      ) : null}
    </>
  );
}

/** `now`: the host's clock, so "in 23m" reads as the CLI says it. */
function pendingWake(t: TFunction, wake: RemoteWake, now: number): string {
  const when = wakeWhen(wake.due, now);
  const line = t("pi.forge.pause.pending", { at: when.at, left: when.left });
  return wake.reason ? `${line} · ${wake.reason}` : line;
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3], paddingBottom: theme.spacing[4] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base, lineHeight: 21 },
  mono: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  monoError: { color: theme.colors.statusDanger },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
