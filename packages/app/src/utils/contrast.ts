// WCAG 2.x contrast for theme tokens: relative luminance, ratio, and alpha compositing for tinted
// surfaces (status tints are `#rrggbb` + an alpha byte over the screen surface).

import { parseHexColor } from "./color";

function channel(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function rgbOf(hex: string): [number, number, number] {
  const rgb = parseHexColor(hex.length === 9 ? hex.slice(0, 7) : hex);
  if (!rgb) throw new Error(`not a hex colour: ${hex}`);
  return rgb;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1–21) between two opaque colours. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Composites `#rrggbbaa` (or `#rrggbb` + alpha) over an opaque background. */
export function compositeOver(color: string, background: string, alpha?: number): string {
  const a = alpha ?? (color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1);
  const fg = rgbOf(color);
  const bg = rgbOf(background);
  const mixed = fg.map((value, i) => Math.round((value * a + bg[i] * (1 - a)) * 255));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
