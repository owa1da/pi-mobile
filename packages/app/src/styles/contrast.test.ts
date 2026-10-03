// The app's text/background pairs, computed from the theme tokens (WCAG 2.x). Body text needs
// 4.5:1; large text, glyphs and control boundaries need 3:1. Light and dark are the two themes
// the app follows (adaptive to the system).

import { describe, expect, it } from "vitest";
import { compositeOver, contrastRatio } from "@/utils/contrast";
import { darkTheme, lightTheme } from "./theme";

const BODY = 4.5;
const LARGE_OR_UI = 3;

type Theme = typeof darkTheme | typeof lightTheme;

function pairs(theme: Theme): [string, string, string, number][] {
  const c = theme.colors;
  const warningBanner = compositeOver(c.statusWarningTint, c.surface0);
  const dangerBanner = compositeOver(c.statusDangerTint, c.surface0);
  return [
    ["foreground on surface0", c.foreground, c.surface0, BODY],
    ["muted text on surface0 (row status, sub-bar, counts)", c.foregroundMuted, c.surface0, BODY],
    ["muted text on surface1 (key bar)", c.foregroundMuted, c.surface1, BODY],
    ["placeholder (muted) on surface2 input", c.foregroundMuted, c.surface2, BODY],
    ["extra-muted meta line on surface0", c.foregroundExtraMuted, c.surface0, BODY],
    ["needs-input glyph/status on surface0", c.statusWarning, c.surface0, BODY],
    ["danger text on surface0", c.statusDanger, c.surface0, BODY],
    ["success glyph on surface0", c.statusSuccess, c.surface0, LARGE_OR_UI],
    ["waiting banner title (muted) on warning tint", c.foregroundMuted, warningBanner, BODY],
    ["waiting banner message on warning tint", c.foreground, warningBanner, BODY],
    ["error banner message on danger tint", c.foreground, dangerBanner, BODY],
    ["muted text on danger tint", c.foregroundMuted, dangerBanner, BODY],
    ["key-bar label on key cap (surface2)", c.foreground, c.surface2, BODY],
    ["armed Ctrl label (surface0 on foreground)", c.surface0, c.foreground, BODY],
    ["selected tab label on surface3", c.foreground, c.surface3, BODY],
    ["primary button text on accent", c.accentForeground, c.accent, BODY],
    // Disabled controls are exempt from 1.4.3, but the label must still be readable as a label.
    ["disabled button label on surface2", c.foregroundExtraMuted, c.surface2, LARGE_OR_UI],
    ["neutral chat chip text on surface2", c.foreground, c.surface2, BODY],
    ["neutral chat chip icon (muted) on surface2", c.foregroundMuted, c.surface2, LARGE_OR_UI],
  ];
}

describe.each([
  ["dark", darkTheme],
  ["light", lightTheme],
] as const)("%s theme contrast", (_name, theme) => {
  it.each(pairs(theme))("%s", (_label, fg, bg, min) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
  });

  it("keeps extra-muted a visible step below muted (hierarchy survives the fix)", () => {
    const { foregroundMuted, foregroundExtraMuted, surface0 } = theme.colors;
    expect(contrastRatio(foregroundMuted, surface0)).toBeGreaterThan(
      contrastRatio(foregroundExtraMuted, surface0),
    );
  });
});

describe("contrast utility", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  it("composites an alpha suffix over the surface", () => {
    expect(compositeOver("#00000080", "#ffffff")).toBe("#7f7f7f");
    expect(compositeOver("#ff0000", "#0000ff", 0)).toBe("#0000ff");
  });
});
