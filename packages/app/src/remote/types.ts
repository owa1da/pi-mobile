// The remote channel v1 (forge <-> pi-mobile), mirrored from the orchestrator-owned contract
// (~/projects/pi-mobile-work/remote-channel.md). forge publishes `state.json` per pi process and
// executes the actions the app drops into its inbox. Areas a forge build has not implemented are
// absent from the state (undefined here); the app hides their screens.

export const REMOTE_PROTOCOL = 1;

// ---------- state.json ----------

export type PromptKind = "select" | "confirm" | "input" | "editor" | "custom";

/** The open dialog (pi's ctx.ui.select/confirm/input/editor, or an extension's custom view). */
export interface RemotePrompt {
  id: string;
  kind: PromptKind;
  title: string;
  message: string | null;
  options: string[] | null;
  placeholder: string | null;
  prefill: string | null;
  /** False for custom dialogs: only the desktop can answer them. */
  answerable: boolean;
  held: boolean;
  since: number;
}

export interface AskOption {
  label: string;
  description: string | null;
}

export interface AskItem {
  question: string;
  header: string | null;
  multiSelect: boolean;
  options: AskOption[];
}

/** One open ask_user item (forge's ask queue): one or more questions answered together. */
export interface AskQuestion {
  id: string;
  blocking: boolean;
  askedAt: number;
  status: "open" | "answered-unsent";
  items: AskItem[];
}

export interface RemoteFooterModel {
  provider: string;
  id: string;
  name: string;
  thinking: string;
}

export interface RemoteFooter {
  model: RemoteFooterModel | null;
  contextPercent: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  cost: number | null;
}

export interface RemoteWake {
  due: number;
  reason: string | null;
  missed: boolean;
}

export interface RemoteSide {
  open: boolean;
  working: boolean;
  sessionFile: string | null;
}

export type TaskKind = "shell" | "workflow" | "agent" | "wake" | "session";

export interface RemoteTask {
  owner: string;
  key: string;
  kind: TaskKind;
  name: string;
  status: string;
  detail: string | null;
  canStop: boolean;
  canResume: boolean;
  sessionFile: string | null;
  logPath: string | null;
  runDir: string | null;
}

export interface RemoteCheckpoint {
  n: number;
  entryId: string;
  label: string;
  at: number;
  files: number;
  added: number;
  removed: number;
}

/** A row of forge's `/` menu (menuRows()). */
export interface RemoteCommand {
  name: string;
  description: string | null;
}

export interface RemotePins {
  pinned: string[];
  recent: string[];
}

export interface RemoteState {
  v: number;
  pid: number;
  sessionId: string;
  rev: number;
  updatedAt: number;
  /** "main" | "side" | "agent:<key>" | "panel:<name>" | "dialog" */
  view: string;
  /** The main editor holds unsent text. */
  draft: boolean;
  /** undefined: the area is absent (not implemented by this forge build); null: no dialog open. */
  prompt?: RemotePrompt | null;
  questions?: AskQuestion[];
  footer?: RemoteFooter | null;
  wake?: RemoteWake | null;
  side?: RemoteSide | null;
  tasks?: RemoteTask[];
  checkpoints?: RemoteCheckpoint[];
  commands?: RemoteCommand[];
  pins?: RemotePins;
}

// ---------- actions ----------

export type RemoteAction =
  | "prompt.respond"
  | "ask.answer"
  | "ask.dismiss"
  | "command.run"
  | "rewind.preview"
  | "rewind.apply"
  | "checkpoint.diff"
  | "checkpoint.restore"
  | "task.stop"
  | "task.resume"
  | "task.tail"
  | "agent.send"
  | "agent.resume"
  | "side.open"
  | "side.send"
  | "side.close"
  | "btw.ask"
  | "btw.fork"
  | "btw.clear"
  | "model.set"
  | "thinking.set"
  | "pin.toggle"
  | "models.list"
  | "usage.refresh"
  /** Not in the v1 list: forge's /cost rows when a build has it (else the footer's cost). */
  | "cost.read"
  | "wake.set"
  | "wake.cancel"
  | "export.run"
  | "session.rename"
  | "session.branch"
  | "session.clear"
  | "sync.status"
  | "sync.run"
  | "changelog.read";

/** One ask answer: the labels picked (option order) and/or the user's own words; null skips it. */
export interface AskAnswer {
  picked: string[];
  typed?: string;
}

/** Typed args for the actions this wave uses; the rest take a plain object. */
export interface RemoteActionArgs {
  "prompt.respond": { id: string; value?: string; cancel?: boolean };
  "ask.answer": { id: string; answers: (AskAnswer | null)[] };
  "ask.dismiss": { id: string };
  "command.run": { line: string };
}

export type ArgsOf<A extends RemoteAction> = A extends keyof RemoteActionArgs
  ? RemoteActionArgs[A]
  : Record<string, unknown>;

export interface RemoteExpect {
  rev?: number;
}

/** The inbox file `<nonce>.json`. */
export interface InboxAction<A extends RemoteAction = RemoteAction> {
  v: number;
  nonce: string;
  writtenAt: number;
  action: A;
  args: ArgsOf<A>;
  expect?: RemoteExpect;
}

// ---------- results ----------

export type ResultCode =
  | "ok"
  | "stale"
  | "expired"
  | "invalid"
  | "refused"
  | "unknown-action"
  | "error";

/** Why forge refused an action (contract v1.1: `data.reason` on a refused result). */
export type RefusalReason =
  | "tui-only"
  | "busy"
  | "template"
  | "skill"
  | "gate"
  | "not-answerable"
  | "not-main";

export interface RemoteResult {
  v: number;
  nonce: string;
  ok: boolean;
  code: ResultCode;
  message: string | null;
  data: unknown;
  at: number;
}
