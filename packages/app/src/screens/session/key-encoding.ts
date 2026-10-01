// Terminal key bar → bytes for the pty. Pure.

export type BarKey =
  | "Escape"
  | "Tab"
  | "Ctrl"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Enter";

export const BAR_KEYS: readonly BarKey[] = [
  "Escape",
  "Tab",
  "Ctrl",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
];

export interface KeyModifiers {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface EncodeOptions {
  /** DECCKM: arrows as ESC O A instead of ESC [ A. */
  applicationCursor?: boolean;
}

const ESC = "\x1b";

const CURSOR_LETTER: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};

const TILDE_CODE: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
};

const CTRL_SYMBOLS: Record<string, string> = {
  "@": "\x00",
  " ": "\x00",
  "2": "\x00",
  "[": "\x1b",
  "3": "\x1b",
  "\\": "\x1c",
  "4": "\x1c",
  "]": "\x1d",
  "5": "\x1d",
  "^": "\x1e",
  "6": "\x1e",
  _: "\x1f",
  "-": "\x1f",
  "7": "\x1f",
  "/": "\x1f",
  "?": "\x7f",
  "8": "\x7f",
};

/** Ctrl+char as a C0 control byte (Ctrl+C → 0x03); unchanged when there is none. */
export function ctrlChar(char: string): string {
  const lower = char.toLowerCase();
  const code = lower.charCodeAt(0);
  if (lower.length === 1 && code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  return CTRL_SYMBOLS[char] ?? char;
}

/** xterm modifier parameter: 1 + shift + 2·alt + 4·ctrl. */
function modifierParam(mods: KeyModifiers): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

function encodeCursor(letter: string, mods: KeyModifiers, opts: EncodeOptions): string {
  const m = modifierParam(mods);
  if (m > 1) return `${ESC}[1;${m}${letter}`;
  return opts.applicationCursor ? `${ESC}O${letter}` : `${ESC}[${letter}`;
}

function encodeTilde(code: number, mods: KeyModifiers): string {
  const m = modifierParam(mods);
  return m > 1 ? `${ESC}[${code};${m}~` : `${ESC}[${code}~`;
}

function encodeSpecial(key: string, mods: KeyModifiers): string | null {
  switch (key) {
    case "Escape":
      return ESC;
    case "Tab":
      return mods.shift ? `${ESC}[Z` : "\t";
    case "Enter":
      return mods.alt ? `${ESC}\r` : "\r";
    case "Backspace":
      return mods.ctrl ? "\x08" : "\x7f";
    default:
      return null;
  }
}

/** Bytes for one key with modifiers, or null for keys this bar does not encode. */
export function encodeKey(
  key: string,
  mods: KeyModifiers = {},
  opts: EncodeOptions = {},
): string | null {
  const letter = CURSOR_LETTER[key];
  if (letter) return encodeCursor(letter, mods, opts);
  const tilde = TILDE_CODE[key];
  if (tilde !== undefined) return encodeTilde(tilde, mods);
  const special = encodeSpecial(key, mods);
  if (special !== null) return special;
  if (key.length !== 1) return null;
  const base = mods.ctrl ? ctrlChar(key) : key;
  return mods.alt ? `${ESC}${base}` : base;
}

/**
 * Soft keyboards deliver typed text as input data, not key events. With the sticky Ctrl armed, the
 * first character becomes its control byte and Ctrl is released.
 */
export function applyStickyCtrl(data: string, armed: boolean): { send: string; consumed: boolean } {
  if (!armed || data.length === 0) return { send: data, consumed: false };
  const first = Array.from(data)[0] ?? "";
  if (first.length !== 1) return { send: data, consumed: true };
  return { send: ctrlChar(first) + data.slice(first.length), consumed: true };
}
