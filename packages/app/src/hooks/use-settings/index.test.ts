import { describe, expect, it } from "vitest";
import { DEFAULT_APP_SETTINGS, normalizeAppSettings, resolveContentMaxWidth } from "./index";

describe("normalizeAppSettings", () => {
  it("returns defaults for missing or malformed input", () => {
    expect(normalizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(normalizeAppSettings({ theme: "nope", codeFontSize: "big" })).toEqual(
      DEFAULT_APP_SETTINGS,
    );
  });

  it("keeps valid values and clamps numeric ones", () => {
    const settings = normalizeAppSettings({ theme: "dark", codeFontSize: 99, language: "en" });
    expect(settings.theme).toBe("dark");
    expect(settings.codeFontSize).toBe(22);
    expect(settings.language).toBe("en");
  });

  it("resolves a null content width to the default", () => {
    expect(resolveContentMaxWidth({ contentMaxWidth: null })).toBeGreaterThan(0);
    expect(resolveContentMaxWidth({ contentMaxWidth: 900 })).toBe(900);
  });
});
