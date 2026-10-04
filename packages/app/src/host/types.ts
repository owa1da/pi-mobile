// Shared host contract: what the UI needs from a host running pi + forge in tmux.
// Owned by the orchestrator. Implementation: src/host/ (host service); consumers: src/app, src/screens.

import type { RemoteResult, RemoteState } from "@/remote/types";
import type { SshConnection } from "@/ssh/types";

// ---------- Saved hosts (app-side storage) ----------

export interface SavedHost {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authType: "key" | "password";
  /** Secret material lives in secure storage under this id, never in this record. */
  secretRef: string;
  /** Pinned "SHA256:..." host key fingerprint (TOFU). */
  hostKeyFingerprint?: string;
  createdAt: number;
  lastConnectedAt?: number;
}

// ---------- Dashboard ----------

export type SessionSection = "needs" | "working" | "completed";

export interface SessionModel {
  provider: string;
  id: string;
  name?: string;
  thinking?: string;
}

export interface SessionRow {
  /** sessionId (stable across live/ended). */
  key: string;
  sessionId: string;
  section: SessionSection;
  live: boolean;
  /** Closed rows: why it ended (quit|new|resume|fork|gone). */
  endReason?: string;
  title: string;
  cwd: string;
  model?: SessionModel;
  state: "idle" | "working" | "waiting" | "closed";
  /** Asking text when the session needs input (waitingFor.title, pendingTitle or question). */
  asking?: string;
  /** Short status line (last error, activity, lastText excerpt). */
  detail?: string;
  /** ms epoch the row's age is measured from. */
  since: number;
  messages: number;
  sessionFile?: string;
  pid?: number;
  tmux?: { socket: string; pane: string };
  wake?: { due: number; missed: boolean; reason?: string };
  /** Remote channel protocol version from the procs record (`"remote": 1`); absent = none. */
  remote?: number;
}

export interface SessionsSnapshot {
  hostName: string;
  /** Host clock (s epoch) when sampled, to compute ages without phone clock skew. */
  hostNow: number;
  rows: SessionRow[];
  counts: Record<SessionSection, number>;
}

// ---------- Chat ----------

export type ToolStatus = "running" | "completed" | "failed";

export type ChatItem =
  | { kind: "user"; id: string; text: string; images: number; timestamp: number }
  | { kind: "assistant"; id: string; text: string; timestamp: number }
  | { kind: "thinking"; id: string; text: string; timestamp: number }
  | {
      kind: "tool";
      id: string; // toolCallId
      name: string;
      args: Record<string, unknown>;
      status: ToolStatus;
      result?: string;
      isError?: boolean;
      timestamp: number;
    }
  | {
      kind: "notice";
      id: string;
      level: "info" | "warning" | "error";
      text: string;
      timestamp: number;
    }
  | { kind: "divider"; id: string; label: string; summary?: string; timestamp: number };

/** Incremental reader state for one session file. */
export interface SessionCursor {
  sessionFile: string;
  offset: number;
}

export interface ChatUpdate {
  cursor: SessionCursor;
  /** Full item list for the active branch after applying the new bytes. */
  items: ChatItem[];
  /** True when the reader had to rebuild from the start (file shrank/replaced, branch changed). */
  reset: boolean;
}

// ---------- Host service ----------

export interface HostEnvironment {
  hostName: string;
  agentDir: string;
  /** Absolute paths resolved through the user's login shell. */
  nodePath: string;
  piCliPath: string;
  tmuxPath: string;
  /** tmux socket new sessions are created on (the one existing pi panes use, else default). */
  tmuxSocket: string;
  homeDir: string;
}

export interface StartSessionInput {
  prompt?: string;
  cwd?: string;
  /** "provider/id"; omitted = pi's own default. */
  model?: string;
  thinking?: string;
}

export interface StartedSession {
  pid: number;
  pane: string;
  windowId: string;
  tmuxSession: string;
}

export interface RemoteSession {
  row: SessionRow;
  state: RemoteState;
}

export interface HostService {
  readonly connection: SshConnection;
  probe(): Promise<HostEnvironment>;
  listSessions(): Promise<SessionsSnapshot>;
  readChat(row: Pick<SessionRow, "sessionFile">, cursor?: SessionCursor): Promise<ChatUpdate>;
  startSession(input: StartSessionInput): Promise<StartedSession>;
  /** Resume a closed session in a new tmux window. Throws if it is live. */
  resumeSession(row: SessionRow): Promise<StartedSession>;
  /** Explicit action only: join a reopen, wait for its native channel, and optionally validate a command. */
  ensureRemoteSession(row: SessionRow, line?: string): Promise<RemoteSession>;
  /** Run a freshly validated command, retrying only one definite stale refusal. */
  runCommand(row: SessionRow, line: string): Promise<RemoteResult>;
  /** Submit explicit text through native input, reopening a closed session if necessary. */
  sendPrompt(row: SessionRow, text: string): Promise<void>;
  /** Single Escape, only while working; rate limited to once per second per pane. */
  abort(row: SessionRow): Promise<void>;
}

export class HostError extends Error {
  constructor(
    public readonly code:
      | "not-found"
      | "pi-missing"
      | "tmux-missing"
      | "forge-missing"
      | "session-live"
      | "session-closed"
      | "waiting-for-input"
      | "pane-busy"
      | "prompt-too-large"
      | "command-failed",
    message: string,
  ) {
    super(message);
    this.name = "HostError";
  }
}
