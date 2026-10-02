// Status bar icon style for the active theme. Pure, so the choice is testable without React Native.
// A light theme needs dark icons and a dark theme light ones; anything unknown falls back to the
// system default rather than guessing.

export type ThemeColorScheme = "light" | "dark";
export type StatusBarStyle = "dark-content" | "light-content" | "default";

export function statusBarStyleFor(
  colorScheme: ThemeColorScheme | string | undefined,
): StatusBarStyle {
  if (colorScheme === "light") return "dark-content";
  if (colorScheme === "dark") return "light-content";
  return "default";
}
