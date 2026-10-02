// The composer's `/` menu: forge's own rows (state.commands), filtered as the name is typed.

import type { RefusalReason, RemoteCommand } from "./types";

/** Where a `/` name opens in the app: a full screen, or a sheet over the session. */
export type NativeTool =
  | "rewind"
  | "checkpoints"
  | "side"
  | "btw"
  | "tasks"
  | "model"
  | "usage"
  | "cost"
  | "changelog"
  | "pause"
  | "export"
  | "rename"
  | "branch"
  | "clear"
  | "sync";

export const SHEET_TOOLS: ReadonlySet<NativeTool> = new Set<NativeTool>([
  "pause",
  "export",
  "rename",
  "branch",
  "clear",
  "sync",
]);

/**
 * The CLI's names that open a native screen instead of command.run (the user's native-screen
 * scope). `/mcp` is not here: it runs through command.run and answers its dialogs in the app.
 */
export const NATIVE_COMMANDS: Readonly<Record<string, NativeTool>> = {
  rewind: "rewind",
  diff: "checkpoints",
  restore: "checkpoints",
  side: "side",
  btw: "btw",
  tasks: "tasks",
  model: "model",
  thinking: "model",
  usage: "usage",
  cost: "cost",
  changelog: "changelog",
  pause: "pause",
  export: "export",
  rename: "rename",
  branch: "branch",
  clear: "clear",
  sync: "sync",
};

/** `/name words…` → its native screen and the words after the name, when it has one. */
export function nativeTarget(
  line: string,
): { tool: NativeTool; name: string; arg: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (!match) return undefined;
  const tool = NATIVE_COMMANDS[match[1]];
  return tool ? { tool, name: match[1], arg: (match[2] ?? "").trim() } : undefined;
}

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

/** `/mcp`'s subcommands that run without a terminal (forge refuses bare `/mcp`: pi's manager view). */
export const MCP_SUBCOMMANDS = ["login", "logout", "reconnect"] as const;
export type McpSubcommand = (typeof MCP_SUBCOMMANDS)[number];

/**
 * The rows the menu offers: forge's rows, with `/mcp` replaced by the subcommands that work here
 * (`/mcp login`, `/mcp logout`, `/mcp reconnect`). Bare `/mcp` opens pi's MCP manager, a
 * terminal-only view, so the menu never offers it.
 */
export function menuRows(
  commands: readonly RemoteCommand[],
  describe: (sub: McpSubcommand) => string,
): RemoteCommand[] {
  return commands.flatMap((command) =>
    command.name === "mcp"
      ? MCP_SUBCOMMANDS.map((sub) => ({ name: `mcp ${sub}`, description: describe(sub) }))
      : [command],
  );
}

/** A row's testID suffix: its name with spaces as dashes (`mcp-reconnect`). */
export function rowTestId(name: string): string {
  return name.replace(/\s+/g, "-");
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

/** What the composer does when forge refuses a `/` line. */
export type Refusal =
  /** A prompt template or skill: it starts a turn, so send the line as a message instead. */
  | { kind: "paste" }
  /** A calm notice (i18n key + params), not an error. */
  | { kind: "notice"; key: string; params: Record<string, string>; testID: string }
  /** Show the refusal as a send error. */
  | { kind: "error" };

const answerHere: Refusal = {
  kind: "notice",
  key: "pi.remote.answerHere",
  params: {},
  testID: "command-answer",
};
const inputBusy: Refusal = {
  kind: "notice",
  key: "pi.remote.inputBusy",
  params: {},
  testID: "command-busy",
};
const computerOnly = (name: string): Refusal => ({
  kind: "notice",
  key: "pi.remote.computerOnly",
  params: { name },
  testID: "command-computer-only",
});
const notMain: Refusal = {
  kind: "notice",
  key: "pi.remote.notMain",
  params: {},
  testID: "command-not-main",
};

/**
 * forge's command.run refusal → what the composer does. Classified by `data.reason` (contract
 * v1.1); the message text is read only when an older forge sent no reason.
 */
export function refusalOutcome(
  name: string,
  message: string | null,
  reason?: RefusalReason,
): Refusal {
  switch (reason) {
    case "template":
    case "skill":
      return { kind: "paste" };
    case "tui-only":
      return name === ANSWER_COMMAND ? answerHere : computerOnly(name);
    case "busy":
      return inputBusy;
    case "not-main":
    case "gate":
      return notMain;
    case "not-answerable":
      return { kind: "error" };
    default:
      return legacyRefusal(name, message ?? "");
  }
}

/** forge builds before v1.1: their refusal wording ("starts a turn", "opens a terminal view", …). */
function legacyRefusal(name: string, text: string): Refusal {
  if (/starts a turn/i.test(text)) return { kind: "paste" };
  if (/opens a terminal view/i.test(text))
    return name === ANSWER_COMMAND ? answerHere : computerOnly(name);
  if (/(dialog|panel).*input/i.test(text)) return inputBusy;
  return { kind: "error" };
}
