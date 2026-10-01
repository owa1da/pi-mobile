// forge's state glyphs as text: ✻ needs input, the · ✢ * ✶ ✻ ✽ spinner while working, ✻/∙ completed.
// One shared 5 fps ticker drives every spinner; Reduce Motion freezes it.

import { memo, useSyncExternalStore } from "react";
import { Text } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import type { GlyphKind } from "@/screens/dashboard/view-model";

const SPINNER = ["·", "✢", "*", "✶", "✻", "✽", "✻", "✶", "*", "✢"];
const TICK_MS = 200;

let frame = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function notifyAll() {
  frame = (frame + 1) % SPINNER.length;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) timer = setInterval(notifyAll, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getFrame = () => frame;
const noSubscribe = () => () => undefined;
const zero = () => 0;

const STATIC: Record<Exclude<GlyphKind, "working">, string> = {
  needs: "✻",
  scheduled: "◷",
  live: "✻",
  closed: "∙",
  failed: "∙",
  interrupted: "∙",
  gone: "∙",
};

function Spinner() {
  const reduced = useReducedMotion();
  const current = useSyncExternalStore(
    reduced ? noSubscribe : subscribe,
    reduced ? zero : getFrame,
    zero,
  );
  return <Text style={[styles.glyph, styles.working]}>{SPINNER[reduced ? 4 : current]}</Text>;
}

export const SessionGlyph = memo(function SessionGlyph({ kind }: { kind: GlyphKind }) {
  if (kind === "working") return <Spinner />;
  return (
    <Text
      style={[styles.glyph, styles[kind]]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {STATIC[kind]}
    </Text>
  );
});

const styles = StyleSheet.create((theme) => ({
  glyph: {
    width: 18,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.lg,
    lineHeight: 22,
    textAlign: "center",
  },
  needs: { color: theme.colors.statusWarning },
  working: { color: theme.colors.foregroundMuted },
  scheduled: { color: theme.colors.foregroundMuted },
  live: { color: theme.colors.statusSuccess },
  closed: { color: theme.colors.statusSuccess },
  failed: { color: theme.colors.statusDanger },
  interrupted: { color: theme.colors.foregroundMuted },
  gone: { color: theme.colors.foregroundExtraMuted },
}));
