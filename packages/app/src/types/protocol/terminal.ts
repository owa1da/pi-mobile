// Inlined from Paseo packages/protocol/src/messages.ts (Apache-2.0): the terminal snapshot shape
// the xterm runtime can restore. Plain types; the daemon's zod schemas are gone.

export interface TerminalCell {
  char: string;
  fg?: number;
  bg?: number;
  fgMode?: number;
  bgMode?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
}

export type TerminalCursorStyle = "block" | "underline" | "bar";

export interface TerminalCursor {
  row: number;
  col: number;
  hidden?: boolean;
  style?: TerminalCursorStyle;
  blink?: boolean;
}

export interface TerminalState {
  rows: number;
  cols: number;
  grid: TerminalCell[][];
  scrollback: TerminalCell[][];
  cursor: TerminalCursor;
  title?: string;
  /** Per-row soft-wrap flags aligned 1:1 with `grid` / `scrollback`. */
  gridWrapped?: boolean[];
  scrollbackWrapped?: boolean[];
}

export type { TerminalInputModeState } from "./terminal-input-mode";
