export * from "./types";
export {
  createHostService,
  MAX_ARGV_PROMPT_BYTES,
  MAX_PROMPT_BYTES,
  ABORT_INTERVAL_MS,
  TERMINAL_TMUX_MESSAGE,
  parseTmuxVersion,
  terminalSupport,
  type HostServiceOptions,
  type HostEnvironmentDetails,
  type PiHostService,
} from "./service";
export { ChatDocument, type ChatUpdateEx } from "./chat";
export {
  DRAFT_MESSAGE,
  HostOutcomeUnknownError,
  PaneBusyError,
  isOutcomeUnknown,
  type PaneBusyReason,
} from "./errors";
export { sanitizePrompt } from "./sanitize";
export { buildSnapshot, parseListing, sessionTitle } from "./procs";
// local-connection.ts is a Node-only test double: import it directly, never through this index.
