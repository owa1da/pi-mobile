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
  /** The status line's short name ("Fake Tiny"). */
  name: string;
  /** The effort the line shows; null for a model that does not think (the line hides it). */
  thinking: string | null;
}

export type ContextTone = "normal" | "warning" | "error";

/** The desktop status line's facts (contract v1.2). */
export interface RemoteFooter {
  /** null when no model is set (never pi's "unknown" stand-in). */
  model: RemoteFooterModel | null;
  contextPercent: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  /** USD; null where the line shows no amount. */
  cost: number | null;
  /** Where pi compacts next, in percent of the window; null when unknown or off. */
  compactAt: number | null;
  compactionPaused: boolean;
  /** The context field's colour on the desktop. */
  contextTone: ContextTone;
  /** The line's items after the facts, as it says them: "1 shell", "◷ wakes in 23m". */
  items: string[];
}

/** The /btw panel on the desktop (contract v1.2). */
export interface RemoteBtw {
  open: boolean;
  /** An answer is still coming. */
  pending: boolean;
  question: string | null;
  /** Why the last answer failed (it wrote no entry). */
  error: string | null;
}

export interface RemoteWake {
  due: number;
  reason: string | null;
  missed: boolean;
}

export interface RemoteSide {
  /** Stable from creation, including before sessionFile; absent on older Forge. */
  id?: string;
  /** Visibility generation, changed by every show/hide path. */
  gen?: number;
  /** Terminal visibility, not existence: a non-null side survives Back to main. */
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
  /** The branch prompt it anchors; null when no prompt precedes it. */
  entryId: string | null;
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
  /** Native draft-independent input, absent on older Forge builds. */
  input?: { submit: boolean; maxBytes: number };
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
  btw?: RemoteBtw | null;
}

// ---------- actions ----------

export type RemoteAction =
  | "input.submit"
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
  | "side.view"
  | "side.send"
  | "side.close"
  | "btw.ask"
  | "btw.fork"
  | "btw.clear"
  | "btw.close"
  | "model.set"
  | "thinking.set"
  | "pin.toggle"
  | "models.list"
  | "usage.refresh"
  /** v1.2: the rows /cost shows. */
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
  "input.submit": { text: string };
  /** Non-destructive visibility; mismatched ownership/generation or no side is stale. */
  "side.view": { open: boolean; id?: string; gen?: number };
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
  /** The session selected by the user, never a replacement sharing its PID. */
  sessionId?: string;
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
  | "not-main"
  /** v1.2: the export target exists; resend with `overwrite: true`. */
  | "exists";

export interface RemoteResult {
  v: number;
  nonce: string;
  ok: boolean;
  code: ResultCode;
  message: string | null;
  data: unknown;
  at: number;
}
