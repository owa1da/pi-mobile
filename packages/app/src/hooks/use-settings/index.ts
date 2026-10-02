import { useCallback, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { isSyntaxThemeId, type SyntaxThemeId } from "@getpaseo/highlight";
import { isNative } from "@/constants/platform";
import { parseAppLanguage, type AppLanguage } from "@/i18n/locales";
import {
  DEFAULT_CONTENT_MAX_WIDTH,
  FONT_SIZE,
  THEME_OPTIONS,
  type ThemePreference,
} from "@/styles/theme";

// Minimal app settings for Pi: appearance + language, persisted to AsyncStorage.

export const APP_SETTINGS_KEY = "@pi-mobile:app-settings";
export const APP_SETTINGS_QUERY_KEY = ["app-settings"];

export const DEFAULT_THEME_PREFERENCE = "auto" satisfies ThemePreference;
export const DEFAULT_UI_BASE_FONT_SIZE = isNative ? 15 : FONT_SIZE.base;
export const DEFAULT_CONTENT_FONT_SIZE = isNative ? 16 : FONT_SIZE.content;
export const DEFAULT_CODE_FONT_SIZE = 12;
export { DEFAULT_CONTENT_MAX_WIDTH };

const FONT_SIZE_BOUNDS = {
  uiBaseFontSize: { min: 10, max: 21 },
  contentFontSize: { min: 10, max: 21 },
  codeFontSize: { min: 9, max: 22 },
} as const;
const MAX_FONT_FAMILY_LENGTH = 200;

export type { AppLanguage };

export interface AppSettings {
  theme: ThemePreference;
  language: AppLanguage;
  uiFontFamily: string; // "" = platform default UI stack
  monoFontFamily: string; // "" = platform default mono stack
  uiBaseFontSize: number;
  contentFontSize: number;
  codeFontSize: number;
  /** Max width of chat and markdown content in px; null follows the current default. */
  contentMaxWidth: number | null;
  syntaxTheme: SyntaxThemeId;
}

export type AppSettingsUpdate =
  | Partial<AppSettings>
  | ((current: AppSettings) => Partial<AppSettings>);

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: DEFAULT_THEME_PREFERENCE,
  language: "system",
  uiFontFamily: "",
  monoFontFamily: "",
  uiBaseFontSize: DEFAULT_UI_BASE_FONT_SIZE,
  contentFontSize: DEFAULT_CONTENT_FONT_SIZE,
  codeFontSize: DEFAULT_CODE_FONT_SIZE,
  contentMaxWidth: null,
  syntaxTheme: "one",
};

export function resolveContentMaxWidth(settings: Pick<AppSettings, "contentMaxWidth">): number {
  return settings.contentMaxWidth ?? DEFAULT_CONTENT_MAX_WIDTH;
}

export function parseClampedNumber(
  value: unknown,
  bounds: { min: number; max: number },
): number | null {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(numeric)));
}

export function sanitizeFontFamily(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > MAX_FONT_FAMILY_LENGTH || /[;{}<>]/.test(trimmed)) return null;
  return trimmed;
}

const THEME_NAMES = new Set<string>(THEME_OPTIONS.map((option) => option.name));

/** Accept whatever is stored, field by field, falling back to defaults for anything invalid. */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_APP_SETTINGS;
  const contentMaxWidth = parseClampedNumber(input.contentMaxWidth, { min: 600, max: 4000 });
  return {
    theme:
      typeof input.theme === "string" && THEME_NAMES.has(input.theme)
        ? (input.theme as ThemePreference)
        : d.theme,
    language: parseAppLanguage(input.language) ?? d.language,
    uiFontFamily: sanitizeFontFamily(input.uiFontFamily) ?? d.uiFontFamily,
    monoFontFamily: sanitizeFontFamily(input.monoFontFamily) ?? d.monoFontFamily,
    uiBaseFontSize:
      parseClampedNumber(input.uiBaseFontSize, FONT_SIZE_BOUNDS.uiBaseFontSize) ?? d.uiBaseFontSize,
    contentFontSize:
      parseClampedNumber(input.contentFontSize, FONT_SIZE_BOUNDS.contentFontSize) ??
      d.contentFontSize,
    codeFontSize:
      parseClampedNumber(input.codeFontSize, FONT_SIZE_BOUNDS.codeFontSize) ?? d.codeFontSize,
    contentMaxWidth,
    syntaxTheme:
      typeof input.syntaxTheme === "string" && isSyntaxThemeId(input.syntaxTheme)
        ? input.syntaxTheme
        : d.syntaxTheme,
  };
}

export async function loadAppSettingsFromStorage(): Promise<AppSettings> {
  try {
    const stored = await AsyncStorage.getItem(APP_SETTINGS_KEY);
    return normalizeAppSettings(stored ? JSON.parse(stored) : null);
  } catch (error) {
    console.warn("[AppSettings] Failed to load settings; using defaults", error);
    return DEFAULT_APP_SETTINGS;
  }
}

export async function saveAppSettings(input: {
  queryClient: QueryClient;
  updates: AppSettingsUpdate;
}): Promise<void> {
  const current =
    input.queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ??
    (await loadAppSettingsFromStorage());
  const patch = typeof input.updates === "function" ? input.updates(current) : input.updates;
  const next = normalizeAppSettings({ ...current, ...patch });
  input.queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, next);
  await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
}

export interface UseAppSettingsReturn {
  settings: AppSettings;
  isLoading: boolean;
  error: unknown;
  updateSettings: (updates: AppSettingsUpdate) => Promise<void>;
  resetSettings: () => Promise<void>;
}

export function useAppSettings(): UseAppSettingsReturn {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: loadAppSettingsFromStorage,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const updateSettings = useCallback(
    (updates: AppSettingsUpdate) => saveAppSettings({ queryClient, updates }),
    [queryClient],
  );
  const resetSettings = useCallback(async () => {
    queryClient.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, DEFAULT_APP_SETTINGS);
    await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(DEFAULT_APP_SETTINGS));
  }, [queryClient]);
  const settings = useMemo(() => data ?? DEFAULT_APP_SETTINGS, [data]);

  return { settings, isLoading: isPending, error: error ?? null, updateSettings, resetSettings };
}
