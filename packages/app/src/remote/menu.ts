// The composer's `/` menu: forge's own rows (state.commands), filtered as the name is typed.

import type { RemoteCommand } from "./types";

/**
 * Commands whose native screens come in a later wave (the user's native-screen scope). They are
 * listed and sent through command.run; when forge refuses one because it would open a TUI-only
 * view, the app says "Coming soon" instead of forge's message.
 */
export const NATIVE_LATER: ReadonlySet<string> = new Set([
  "rewind",
  "restore",
  "diff",
  "side",
  "btw",
  "tasks",
  "model",
  "thinking",
  "usage",
  "cost",
  "pause",
  "export",
  "rename",
  "branch",
  "fork",
  "tree",
  "clear",
  "sync",
  "mcp",
  "changelog",
]);

/** `/answer`: the app already shows pi's open questions above the composer. */
export const ANSWER_COMMAND = "answer";

/**
 * The name being typed when the menu should show: the text starts with `/` and has no space
 * yet (`/wor` → "wor", `/` → ""). Undefined otherwise (the menu is closed).
 */
export function slashQuery(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const rest = text.slice(1);
  if (/\s/.test(rest)) return undefined;
  return rest;
}

/** Rows matching `query`: names starting with it first (menu order kept), then names containing it. */
export function filterCommands(commands: readonly RemoteCommand[], query: string): RemoteCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...commands];
  const starts: RemoteCommand[] = [];
  const contains: RemoteCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) starts.push(command);
    else if (name.includes(q)) contains.push(command);
  }
  return [...starts, ...contains];
}

/** The composer text after tapping a row: the name and a space, ready for its words. */
export function completeCommand(command: RemoteCommand): string {
  return `/${command.name} `;
}

/** `/name words…` → its name, or undefined when the line is not a `/` command. */
export function commandName(line: string): string | undefined {
  const match = /^\/(\S+)/.exec(line.trim());
  return match?.[1];
}

/**
 * The command a sent line runs through command.run, when it names one of forge's rows; else it
 * is sent as a message. Skills (`/skill:x`) start a model turn, so they always go as a message.
 */
export function matchCommand(
  line: string,
  commands: readonly RemoteCommand[] | undefined,
): RemoteCommand | undefined {
  const name = commandName(line);
  if (!name || !commands || name.startsWith("skill:")) return undefined;
  return commands.find((command) => command.name === name);
}

/** forge refused `name` because its screen is TUI-only for now: say "Coming soon". */
export function isComingSoon(name: string): boolean {
  return NATIVE_LATER.has(name);
}

/** What the composer does when forge refuses a `/` line. */
export type Refusal =
  /** A prompt template or skill: it starts a turn, so send the line as a message instead. */
  | { kind: "paste" }
  /** A calm notice (i18n key + params), not an error. */
  | { kind: "notice"; key: string; params: Record<string, string>; testID: string }
  /** Show the refusal as a send error. */
  | { kind: "error" };

/**
 * forge's command.run refusals (docs/remote.md "Commands") by their message: "starts a turn"
 * (template/skill), "opens a terminal view" (TUI_ONLY), "has the terminal's input" (a dialog or a
 * panel holds main's input). Anything else is an error.
 */
export function refusalOutcome(name: string, message: string | null): Refusal {
  const text = message ?? "";
  if (/starts a turn/i.test(text)) return { kind: "paste" };
  if (/opens a terminal view/i.test(text) || (!text && isComingSoon(name))) {
    if (name === ANSWER_COMMAND)
      return { kind: "notice", key: "pi.remote.answerHere", params: {}, testID: "command-answer" };
    if (isComingSoon(name))
      return {
        kind: "notice",
        key: "pi.remote.comingSoon",
        params: { name },
        testID: "command-coming-soon",
      };
    return {
      kind: "notice",
      key: "pi.remote.computerOnly",
      params: { name },
      testID: "command-computer-only",
    };
  }
  if (/(dialog|panel).*input/i.test(text))
    return { kind: "notice", key: "pi.remote.inputBusy", params: {}, testID: "command-busy" };
  return { kind: "error" };
}
