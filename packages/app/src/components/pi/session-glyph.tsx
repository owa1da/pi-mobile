// forge's state glyphs as text: ✻ needs input, the · ✢ * ✶ ✻ ✽ spinner while working, ✻/● completed.
// One shared 5 fps ticker drives every spinner. Under Reduce Motion the working glyph is a still ✢,
// a different shape from needs-input ✻, so state reads without motion. Glyphs are decorative to
// screen readers: the row's label carries the state word.

import { memo, useSyncExternalStore } from "react";
import { Text } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { WORKING_FRAMES, glyphFor, isDotGlyph } from "@/screens/dashboard/glyphs";
import type { GlyphKind } from "@/screens/dashboard/view-model";

const TICK_MS = 200;

let frame = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function notifyAll() {
  frame = (frame + 1) % WORKING_FRAMES.length;
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

const HIDDEN_FROM_A11Y = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
  accessible: false,
  // The glyph column is a fixed 18dp rail; the state word lives in the row's label, so the glyph
  // grows only a little with the system font size and never pushes the title.
  maxFontSizeMultiplier: 1.3,
} as const;

function Spinner({ running }: { running?: boolean }) {
  const reduced = useReducedMotion();
  const current = useSyncExternalStore(
    reduced ? noSubscribe : subscribe,
    reduced ? zero : getFrame,
    zero,
  );
  return (
    <Text style={[styles.glyph, running ? styles.running : styles.working]} {...HIDDEN_FROM_A11Y}>
      {glyphFor("working", reduced, current)}
    </Text>
  );
}

export const SessionGlyph = memo(function SessionGlyph({
  kind,
  running,
}: {
  kind: GlyphKind;
  /** The working row's spinner: pi's working colour (forge 75), not the rows' grey. */
  running?: boolean;
}) {
  if (kind === "working") return <Spinner running={running} />;
  return (
    <Text
      style={[styles.glyph, isDotGlyph(kind) && styles.dot, styles[kind]]}
      {...HIDDEN_FROM_A11Y}
    >
      {glyphFor(kind, false)}
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
  // ● drawn a step down so its ink matches ✻ (a full-size disc would outweigh the asterisks).
  dot: { fontSize: theme.fontSize.sm },
  needs: { color: theme.colors.statusWarning },
  working: { color: theme.colors.foregroundMuted },
  // Light: the palette's blue 600 (5.2:1 on white); the light running dot is 3.6:1, too pale for
  // the verb beside it. Dark: the running dot itself (7:1).
  running: {
    color:
      theme.colorScheme === "light"
        ? theme.colors.palette.blue[600]
        : theme.colors.statusDotRunning,
  },
  scheduled: { color: theme.colors.foregroundMuted },
  live: { color: theme.colors.statusSuccess },
  closed: { color: theme.colors.statusSuccess },
  failed: { color: theme.colors.statusDanger },
  interrupted: { color: theme.colors.foregroundMuted },
  gone: { color: theme.colors.foregroundExtraMuted },
}));
