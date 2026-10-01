import { type ReactNode, useEffect, useState } from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import {
  DEFAULT_THEME_PREFERENCE,
  resolveContentMaxWidth,
  useAppSettings,
  type AppSettings,
} from "@/hooks/use-settings";
import { PLUGIN_THEME_PREFERENCE, THEME_TO_UNISTYLES } from "@/styles/theme";
import { applyAppearance } from "./apply";

function applyTheme(preference: AppSettings["theme"]): void {
  const builtInPreference =
    preference === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : preference;
  if (builtInPreference === "auto") {
    UnistylesRuntime.setAdaptiveThemes(true);
    return;
  }

  UnistylesRuntime.setAdaptiveThemes(false);
  UnistylesRuntime.setTheme(THEME_TO_UNISTYLES[builtInPreference]);
}

/** Applies the persisted theme, fonts, and content width before rendering the app. */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { settings, isLoading } = useAppSettings();
  const [hasAppliedAppearance, setHasAppliedAppearance] = useState(false);

  useEffect(() => {
    if (isLoading) return;
    applyTheme(settings.theme);
    applyAppearance({
      uiFontFamily: settings.uiFontFamily,
      monoFontFamily: settings.monoFontFamily,
      uiBaseFontSize: settings.uiBaseFontSize,
      contentFontSize: settings.contentFontSize,
      codeFontSize: settings.codeFontSize,
      contentMaxWidth: resolveContentMaxWidth({ contentMaxWidth: settings.contentMaxWidth }),
      syntaxTheme: settings.syntaxTheme,
    });
    setHasAppliedAppearance(true);
  }, [
    isLoading,
    settings.theme,
    settings.uiFontFamily,
    settings.monoFontFamily,
    settings.uiBaseFontSize,
    settings.contentFontSize,
    settings.codeFontSize,
    settings.contentMaxWidth,
    settings.syntaxTheme,
  ]);

  // Mount screens only after the first settings load is applied, so startup does not
  // render once with default fonts and then re-render with the user's.
  if (!hasAppliedAppearance) return null;

  return children;
}
