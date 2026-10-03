// Shared pieces of the native forge screens: the frame (back header + keyboard-aware body), the
// "Update forge" state, a list row and section label in the app's row grammar, and one hook that
// runs a remote action with a busy flag, an inline error and an unknown-action flag.

import { router } from "expo-router";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import Animated from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { AssistantFileLinkResolverProvider } from "@/assistant-file-links";
import { BackHeader } from "@/components/headers/back-header";
import { EmptyState } from "@/components/pi/empty-state";
import { MutedSpinner } from "@/components/pi/icons";
import { InlineBanner } from "@/components/pi/inline-banner";
import { ToolCallSheetProvider } from "@/components/tool-call-sheet";
import { useToast } from "@/contexts/toast-context";
import { useKeyboardShiftStyle } from "@/keyboard/shift";
import { isRemoteError, type RemoteErrorCode } from "@/remote/errors";
import type { NativeTool } from "@/remote/menu";
import type { ArgsOf, RemoteAction } from "@/remote/types";
import { remoteMessage } from "@/screens/session/use-answers";
import type { RemoteChannel } from "@/screens/session/use-remote-channel";
import { MIN_TOUCH } from "@/styles/touch";

/** Screens under /h/[hostId]/f/[sessionId]/[tool]: the CLI's views plus a checkpoint's diff and a task. */
export type ForgeTool =
  | Exclude<NativeTool, "pause" | "export" | "rename" | "branch" | "clear" | "sync">
  | "diff"
  | "task";

export function openForge(
  hostId: string,
  sessionId: string,
  tool: ForgeTool,
  extra: Record<string, string> = {},
  replace = false,
) {
  const href = {
    pathname: "/h/[hostId]/f/[sessionId]/[tool]",
    params: { hostId, sessionId, tool, ...extra },
  } as const;
  if (replace) router.replace(href as never);
  else router.push(href as never);
}

/** Back to the session's chat, closing every forge screen above it. */
export function backToSession(hostId: string, sessionId: string) {
  router.dismissTo({
    pathname: "/h/[hostId]/s/[sessionId]",
    params: { hostId, sessionId },
  } as never);
}

const FILL = { flex: 1 };

export function ForgeFrame({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  const { style } = useKeyboardShiftStyle({ mode: "padding" });
  return (
    <View style={styles.screen}>
      <BackHeader title={title} rightContent={right} />
      <Animated.View style={[FILL, style]}>{children}</Animated.View>
    </View>
  );
}

/** The screen's area is absent, or forge answered unknown-action. */
export function UpdateForge() {
  const { t } = useTranslation();
  // What is missing and why; the header's back arrow is the way back.
  return (
    <EmptyState
      title={t("pi.remote.errors.unknown-action")}
      body={t("pi.forge.updateBody")}
      testID="forge-update"
    />
  );
}

export function Loading({ testID }: { testID?: string }) {
  const { t } = useTranslation();
  return (
    <View
      style={styles.center}
      accessible
      accessibilityLabel={t("pi.session.loading")}
      testID={testID}
    >
      <MutedSpinner size="small" />
    </View>
  );
}

export function ErrorLine({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  if (!message) return null;
  return (
    <View style={styles.error}>
      <InlineBanner
        tone="danger"
        message={message}
        dismissLabel={onDismiss ? t("pi.session.dismiss") : undefined}
        onDismiss={onDismiss}
        testID="forge-error"
      />
    </View>
  );
}

export const ListRow = memo(function ListRow({
  title,
  subtitle,
  onPress,
  right,
  mono,
  selected,
  testID,
  label,
  pressKey,
  onPressKey,
}: {
  title: string;
  subtitle?: string | null;
  onPress?: () => void;
  /** With onPressKey: the row calls onPressKey(pressKey) (a list's one stable callback). */
  pressKey?: string;
  onPressKey?: (key: string) => void;
  right?: ReactNode;
  mono?: boolean;
  selected?: boolean;
  testID?: string;
  label?: string;
}) {
  const keyed = useCallback(() => {
    if (pressKey !== undefined) onPressKey?.(pressKey);
  }, [onPressKey, pressKey]);
  const press = onPress ?? (onPressKey && pressKey !== undefined ? keyed : undefined);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.row, pressed && press && styles.pressed],
    [press],
  );
  const a11yState = useMemo(() => (selected === undefined ? undefined : { selected }), [selected]);
  return (
    <View style={styles.rowWrap}>
      <Pressable
        onPress={press}
        disabled={!press}
        style={rowStyle}
        accessibilityRole={press ? "button" : undefined}
        accessibilityState={a11yState}
        accessibilityLabel={label ?? [title, subtitle].filter(Boolean).join(", ")}
        testID={testID}
      >
        <View style={styles.rowText}>
          <Text style={[styles.title, mono && styles.mono]} numberOfLines={2}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {right}
    </View>
  );
});

export function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={styles.section} accessibilityRole="header">
      {children}
    </Text>
  );
}

/** ChatView and its components need these providers (as the session's chat has them). */
export function TranscriptProviders({ children }: { children: ReactNode }) {
  const toast = useToast();
  return (
    <AssistantFileLinkResolverProvider toast={toast}>
      <ToolCallSheetProvider>{children}</ToolCallSheetProvider>
    </AssistantFileLinkResolverProvider>
  );
}

/** ok: forge's data and its report line (`message`: rewind.apply and checkpoint.restore say what moved). */
export type ActionOutcome =
  | { ok: true; data: unknown; message: string | null }
  | { ok: false; error: unknown };

/** Runs remote actions for a screen: one busy flag, an inline error, and \"Update forge\" on unknown-action. */
export function useForgeAction(channel: RemoteChannel) {
  const { t } = useTranslation();
  const send = channel.send;
  const [busy, setBusy] = useState<RemoteAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const run = useCallback(
    async <A extends RemoteAction>(
      action: A,
      args: ArgsOf<A>,
      quiet: readonly RemoteErrorCode[] = [],
    ): Promise<ActionOutcome> => {
      setBusy(action);
      setError(null);
      try {
        const result = await send(action, args);
        return { ok: true, data: result.data, message: result.message };
      } catch (err) {
        if (isRemoteError(err, "unknown-action")) setUnsupported(true);
        else if (!(isRemoteError(err) && quiet.includes(err.code))) setError(remoteMessage(t, err));
        return { ok: false, error: err };
      } finally {
        setBusy(null);
      }
    },
    [send, t],
  );
  const clearError = useCallback(() => setError(null), []);
  return { busy, error, unsupported, run, clearError };
}

export const forgeStyles = StyleSheet.create((theme) => ({
  scroll: { paddingBottom: theme.spacing[6] },
  intro: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  mono: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[2] },
  rowWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    paddingRight: theme.spacing[2],
  },
  row: {
    flex: 1,
    minHeight: MIN_TOUCH + 8,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  pressed: { backgroundColor: theme.colors.interactionHighlight },
  rowText: { gap: 2 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  mono: { fontFamily: theme.fontFamily.mono, fontSize: theme.fontSize.sm },
  subtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  section: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
