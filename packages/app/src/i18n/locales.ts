export type SupportedLocale = "en";
export type AppLanguage = "system" | SupportedLocale;

export const DEFAULT_LOCALE: SupportedLocale = "en";

const SUPPORTED_LANGUAGES = new Set<AppLanguage>(["system", "en"]);

export function parseAppLanguage(value: unknown): AppLanguage | null {
  return typeof value === "string" && SUPPORTED_LANGUAGES.has(value as AppLanguage)
    ? (value as AppLanguage)
    : null;
}

/** Pi ships English only; every system locale resolves to it until more resources are added. */
export function resolveSupportedLocale(
  language: AppLanguage,
  _systemLocales: readonly string[],
): SupportedLocale {
  return language === "system" ? DEFAULT_LOCALE : language;
}
