import { describe, expect, it } from "vitest";
import { parseAppLanguage, resolveSupportedLocale } from "./locales";

describe("parseAppLanguage", () => {
  it("accepts system and en", () => {
    expect(["system", "en"].map(parseAppLanguage)).toEqual(["system", "en"]);
  });

  it("returns null for unknown values", () => {
    expect(parseAppLanguage("de")).toBeNull();
    expect(parseAppLanguage(null)).toBeNull();
  });
});

describe("resolveSupportedLocale", () => {
  it("resolves system to English", () => {
    expect(resolveSupportedLocale("system", ["fr-FR"])).toBe("en");
  });
});
