// The kept xterm webview attached to an SSH pty running the session's tmux attach command.
// Opens once the emulator reports its size; closes the shell and runs cleanupCommand on unmount.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import WebViewTerminalEmulator from "@/components/terminal-emulator-webview.native";
import type { TerminalEmulatorHandle } from "@/components/terminal-emulator-contract";
import { Button } from "@/components/ui/button";
import type { SessionRow } from "@/host/types";
import { useAppSettings } from "@/hooks/use-settings";
import { applyStickyCtrl, encodeKey, type BarKey } from "@/screens/session/key-encoding";
import type { SshShell } from "@/ssh/types";
import { connectionStore } from "@/stores/app";
import type { TerminalInputModeState } from "@/types/protocol/terminal-input-mode";
import { toXtermTheme } from "@/utils/to-xterm-theme";
import { MutedSpinner } from "./icons";
import { KeyBar } from "./key-bar";

const ThemedTerminal = withUnistyles(WebViewTerminalEmulator, (theme) => ({
  xtermTheme: toXtermTheme(theme.colors.terminal),
  fontFamily: theme.fontFamily.mono,
}));

const FONT_SIZE = 13;
/** If the renderer never reports a size, attach at a classic 80×24 anyway. */
const SIZE_FALLBACK_MS = 2500;

type ShellStatus = "connecting" | "open" | "closed" | "error";

interface Size {
  cols: number;
  rows: number;
}

function useTerminalShell(hostId: string, row: SessionRow) {
  const emulatorRef = useRef<TerminalEmulatorHandle | null>(null);
  const shellRef = useRef<SshShell | null>(null);
  const cleanupRef = useRef<string | null>(null);
  const openingRef = useRef(false);
  const unmountedRef = useRef(false);
  const [status, setStatus] = useState<ShellStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  // The row object changes on every listing poll; read it at open time so `open` stays stable.
  const rowRef = useRef(row);
  rowRef.current = row;

  const open = useCallback(
    async (size: Size) => {
      if (openingRef.current || shellRef.current) return;
      openingRef.current = true;
      const service = connectionStore.getState().getService(hostId);
      if (!service) {
        openingRef.current = false;
        setStatus("error");
        setError(null);
        return;
      }
      try {
        const attachment = service.terminalFor(rowRef.current);
        cleanupRef.current = attachment.cleanupCommand;
        const shell = await service.connection.openShell({ ...size, command: attachment.command });
        if (unmountedRef.current) {
          shell.close();
          return;
        }
        shellRef.current = shell;
        shell.onData((bytes) => emulatorRef.current?.writeOutput(bytes));
        shell.onClose(() => {
          shellRef.current = null;
          if (!unmountedRef.current) setStatus("closed");
        });
        setStatus("open");
      } catch (caught) {
        if (unmountedRef.current) return;
        setStatus("error");
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [hostId],
  );

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      shellRef.current?.close();
      shellRef.current = null;
      const cleanup = cleanupRef.current;
      const service = connectionStore.getState().getService(hostId);
      if (cleanup && service) void service.connection.exec(cleanup).catch(() => undefined);
    };
  }, [hostId]);

  return { emulatorRef, shellRef, open, status, error };
}

interface TerminalViewProps {
  hostId: string;
  row: SessionRow;
  onReconnect: () => void;
}

export function TerminalView({ hostId, row, onReconnect }: TerminalViewProps) {
  const { settings } = useAppSettings();
  const { emulatorRef, shellRef, open, status, error } = useTerminalShell(hostId, row);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const ctrlRef = useRef(false);
  const appCursorRef = useRef(false);
  const sizedRef = useRef(false);

  const setCtrl = useCallback((armed: boolean) => {
    ctrlRef.current = armed;
    setCtrlArmed(armed);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!sizedRef.current) void open({ cols: 80, rows: 24 });
    }, SIZE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [open]);

  const onResize = useCallback(
    ({ rows, cols }: { rows: number; cols: number }) => {
      if (rows <= 0 || cols <= 0) return;
      sizedRef.current = true;
      if (shellRef.current) shellRef.current.resize(cols, rows);
      else void open({ cols, rows });
    },
    [open, shellRef],
  );

  const onInput = useCallback(
    (data: string) => {
      const { send, consumed } = applyStickyCtrl(data, ctrlRef.current);
      if (consumed) setCtrl(false);
      shellRef.current?.write(send);
    },
    [setCtrl, shellRef],
  );

  const onTerminalKey = useCallback(
    (input: { key: string; ctrl: boolean; shift: boolean; alt: boolean }) => {
      const bytes = encodeKey(input.key, input, { applicationCursor: appCursorRef.current });
      if (bytes) shellRef.current?.write(bytes);
    },
    [shellRef],
  );

  const onInputModeChange = useCallback((state: TerminalInputModeState) => {
    appCursorRef.current = Boolean(state.applicationCursorKeys);
  }, []);

  const onModifiersConsumed = useCallback(() => setCtrl(false), [setCtrl]);

  const onKey = useCallback(
    (key: BarKey) => {
      if (key === "Ctrl") {
        setCtrl(!ctrlRef.current);
        return;
      }
      const bytes = encodeKey(
        key,
        { ctrl: ctrlRef.current },
        { applicationCursor: appCursorRef.current },
      );
      setCtrl(false);
      if (bytes) shellRef.current?.write(bytes);
    },
    [setCtrl, shellRef],
  );

  const pendingModifiers = useMemo(
    () => ({ ctrl: ctrlArmed, shift: false, alt: false }),
    [ctrlArmed],
  );

  return (
    <View style={styles.fill}>
      <View style={styles.fill}>
        <ThemedTerminal
          ref={emulatorRef}
          streamKey={`${hostId}:${row.sessionId}`}
          supportsTerminalInputModeReplay={false}
          scrollbackLines={settings.terminalScrollbackLines}
          fontSize={FONT_SIZE}
          onInput={onInput}
          onResize={onResize}
          onTerminalKey={onTerminalKey}
          onInputModeChange={onInputModeChange}
          onPendingModifiersConsumed={onModifiersConsumed}
          pendingModifiers={pendingModifiers}
          testId="terminal-surface"
        />
        <TerminalOverlay status={status} error={error} onReconnect={onReconnect} />
      </View>
      <KeyBar ctrlArmed={ctrlArmed} onKey={onKey} />
    </View>
  );
}

function TerminalOverlay({
  status,
  error,
  onReconnect,
}: {
  status: ShellStatus;
  error: string | null;
  onReconnect: () => void;
}) {
  const { t } = useTranslation();
  if (status === "open") return null;
  if (status === "connecting") {
    return (
      <View style={styles.overlay} pointerEvents="none">
        <MutedSpinner size="small" />
        <Text style={styles.overlayText}>{t("pi.terminal.connecting")}</Text>
      </View>
    );
  }
  const message =
    status === "closed"
      ? t("pi.terminal.closed")
      : t("pi.terminal.failed", { message: error ?? t("pi.connect.errors.lost") });
  return (
    <View style={[styles.overlay, styles.overlaySolid]}>
      <Text style={styles.overlayText}>{message}</Text>
      <Button variant="secondary" onPress={onReconnect} testID="terminal-reconnect">
        {t("pi.terminal.reconnect")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1 },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  overlaySolid: { backgroundColor: theme.colors.terminal.background },
  overlayText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
