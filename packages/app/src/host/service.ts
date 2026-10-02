// HostService over one SshConnection. Every call is one `exec` of a POSIX sh script (see
// commands.ts) except probe (once, cached) and the resume-then-send path of sendPrompt.

import { SSH_ERROR_CODES } from "@/ssh/errors";
import type { SshConnection } from "@/ssh/types";

import { ChatReader, DEFAULT_CHAT_CAP, type ChatUpdateEx } from "./chat";
import {
  abortScript,
  attachCleanupScript,
  attachScript,
  listingScript,
  makeNonce,
  probeScript,
  sendScript,
  startScript,
  windowName,
  wrapForAnyShell,
  wrapWithHostTimeout,
  parseStartedLine,
} from "./commands";
import { base64EncodeText, utf8ByteLength } from "./encoding";
import { DRAFT_MESSAGE, HostOutcomeUnknownError, PaneBusyError } from "./errors";
import { buildSnapshot, parseListing } from "./procs";
import { sanitizePrompt } from "./sanitize";
import {
  HostError,
  type HostEnvironment,
  type HostService,
  type SessionCursor,
  type SessionRow,
  type SessionsSnapshot,
  type StartSessionInput,
  type StartedSession,
  type TerminalAttachment,
} from "./types";

/** tmux's command message limit is 16 KiB; forge hands at most this much to a new window's argv. */
export const MAX_ARGV_PROMPT_BYTES = 8 * 1024;
/** Prompts are pasted through a tmux buffer; anything larger is refused. */
export const MAX_PROMPT_BYTES = 1024 * 1024;
export const ABORT_INTERVAL_MS = 1000;
/** A mutating script is killed on the host this many seconds before the phone's exec timeout. */
const HOST_TIMEOUT_MARGIN_S = 5;
/** Resume without a prompt: how long to wait for the new pi to register before returning. */
const SOFT_READY_MS = 15_000;

export const TERMINAL_TMUX_MESSAGE = "Terminal view needs tmux 3.2 or newer";

export interface HostServiceOptions {
  /** The agent dir (default: the login shell's PI_CODING_AGENT_DIR, else ~/.pi/agent). */
  agentDir?: string;
  /** The tmux socket for new sessions (default: the one live pi records name, else tmux's default). */
  tmuxSocket?: string;
  /** Resolve node/pi/tmux through the user's login shell (default true). */
  useLoginShell?: boolean;
  /** Bytes per chat read (default 1 MiB). */
  chatChunkBytes?: number;
  /** How long a resumed/started pi may take to show its prompt before a prompt is pasted (default 30 s). */
  readyTimeoutMs?: number;
  now?: () => number;
}

export interface HostEnvironmentDetails extends HostEnvironment {
  /** "node": run `nodePath piCliPath`; "exec": run `piCliPath` itself (a wrapper script). */
  piKind: "node" | "exec";
  /** PATH from the login shell, given to a tmux server this service starts. */
  loginPath: string;
  /** Undefined when `tmux -V` could not be parsed (treated as old). */
  tmuxVersion?: [number, number];
  /** NAME=value pairs forwarded to new windows (forge's FORWARDED_ENV). */
  forwardEnv: string[];
  /** NAME=value pairs (PATH, LANG, LC_*) for a tmux server this service starts. */
  serverEnv: string[];
  procsDir: string;
}

export interface PiHostService extends HostService {
  probe(): Promise<HostEnvironmentDetails>;
  readChat(row: Pick<SessionRow, "sessionFile">, cursor?: SessionCursor): Promise<ChatUpdateEx>;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function tagged(stdout: string, nonce: string): string[] {
  const prefix = `${nonce} `;
  return stdout
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

/** `tmux 3.6`, `tmux 3.3a`, `tmux next-3.7` → [major, minor]; anything else → undefined (old). */
export function parseTmuxVersion(text: string): [number, number] | undefined {
  const match = /(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

function versionAtLeast(v: [number, number] | undefined, major: number, minor: number): boolean {
  if (!v) return false;
  return v[0] > major || (v[0] === major && v[1] >= minor);
}

/** Terminal attach needs tmux >= 3.2 (attach -f ignore-size); keep-last needs 3.4. Unknown = old. */
export function terminalSupport(version: [number, number] | undefined): {
  ok: boolean;
  keepLast: boolean;
} {
  return { ok: versionAtLeast(version, 3, 2), keepLast: versionAtLeast(version, 3, 4) };
}

const LOCALE_PAIR = /^(LANG|LC_[A-Z_]+)=[A-Za-z0-9_.@-]+$/;

/** The probe's `key=value` lines, and its `loc=NAME=value` locale lines (LANG, LC_*). */
function parseProbeLines(lines: string[]): {
  kv: Map<string, string>;
  locales: Map<string, string>;
} {
  const kv = new Map<string, string>();
  const locales = new Map<string, string>();
  for (const line of lines) {
    if (line.startsWith("loc=")) {
      const pair = line.slice(4).trim();
      if (LOCALE_PAIR.test(pair)) locales.set(pair.slice(0, pair.indexOf("=")), pair);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return { kv, locales };
}

function randomHex(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** An exec error after which the command may have run on the host (timeout, dropped mid-run). */
function mayHaveRun(error: unknown): boolean {
  const code = errorCode(error);
  if (code === SSH_ERROR_CODES.TIMEOUT || code === SSH_ERROR_CODES.CONNECTION_CLOSED) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (code === SSH_ERROR_CODES.EXEC_FAILED) return /Reading command output/i.test(message);
  return /timed out/i.test(message);
}

const OUTCOME_UNKNOWN_MESSAGE =
  "The host did not confirm the result in time. It may or may not have been done; check the chat before sending again.";

interface PaneTarget {
  pid: number;
  pane: string;
  socket: string;
  sessionId: string;
}

type Reopened =
  | { kind: "live"; row: SessionRow }
  | { kind: "resumed"; started: StartedSession; delivered: boolean };

class HostServiceImpl implements PiHostService {
  private env: HostEnvironmentDetails | undefined;
  private probing: Promise<HostEnvironmentDetails> | undefined;
  private readonly chat: ChatReader;
  private readonly lastAbort = new Map<string, number>();
  /** One start/resume in flight per sessionId: concurrent resumes and sends join it. */
  private readonly reopening = new Map<string, Promise<Reopened>>();
  private readonly now: () => number;

  constructor(
    readonly connection: SshConnection,
    private readonly options: HostServiceOptions = {},
  ) {
    this.chat = new ChatReader(
      (script) => this.run(script),
      options.chatChunkBytes ?? DEFAULT_CHAT_CAP,
    );
    this.now = options.now ?? Date.now;
  }

  private async run(
    script: string,
    opts: { stdin?: string; timeoutMs?: number; mutating?: boolean } = {},
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const command = opts.mutating
      ? wrapWithHostTimeout(script, Math.floor(timeoutMs / 1000) - HOST_TIMEOUT_MARGIN_S)
      : wrapForAnyShell(script);
    let result;
    try {
      result = await this.connection.exec(command, {
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
        timeoutMs,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (opts.mutating && mayHaveRun(error))
        throw new HostOutcomeUnknownError(`${OUTCOME_UNKNOWN_MESSAGE} (${detail})`);
      throw new HostError("command-failed", `Host command failed: ${detail}`);
    }
    if (opts.mutating && (result.exitCode === 124 || result.exitCode === 137))
      throw new HostOutcomeUnknownError(OUTCOME_UNKNOWN_MESSAGE);
    if (result.exitCode !== 0)
      throw new HostError(
        "command-failed",
        firstLine(result.stderr) ||
          `Host command exited with ${result.exitCode === null ? "no status" : result.exitCode}`,
      );
    return result.stdout;
  }

  // ---------------- probe ----------------

  probe(): Promise<HostEnvironmentDetails> {
    const p = this.doProbe().then((env) => {
      this.env = env;
      return env;
    });
    this.probing = p;
    p.catch(() => {
      if (this.probing === p) this.probing = undefined;
    });
    return p;
  }

  private ensureProbe(): Promise<HostEnvironmentDetails> {
    if (this.env) return Promise.resolve(this.env);
    return this.probing ?? this.probe();
  }

  private async doProbe(): Promise<HostEnvironmentDetails> {
    const nonce = makeNonce();
    const out = await this.run(
      probeScript({
        nonce,
        agentDirOverride: this.options.agentDir,
        socketOverride: this.options.tmuxSocket,
        useLoginShell: this.options.useLoginShell ?? true,
      }),
      { timeoutMs: 45_000 },
    );
    const { kv, locales } = parseProbeLines(tagged(out, nonce));
    if (!kv.has("host")) throw new HostError("command-failed", "The host probe printed nothing");
    const get = (key: string) => kv.get(key) ?? "";
    const piKind = get("pikind") === "node" ? "node" : "exec";
    if (!get("pi"))
      throw new HostError(
        "pi-missing",
        "pi is not installed on this host (not found in the login shell's PATH)",
      );
    if (piKind === "node" && !get("node"))
      throw new HostError("pi-missing", "node is not found in the login shell's PATH");
    if (!get("tmux")) throw new HostError("tmux-missing", "tmux is not installed on this host");
    const agentDir = get("agent");
    if (get("forge") !== "1")
      throw new HostError(
        "forge-missing",
        `The forge extension pack is not set up in ${agentDir} (no forge/procs)`,
      );
    const tv = parseTmuxVersion(get("tmuxv"));
    const homeDir = get("home");
    const forwardEnv: string[] = [];
    const loginAgentDir = get("env_PI_CODING_AGENT_DIR");
    if (this.options.agentDir || loginAgentDir || agentDir !== `${homeDir}/.pi/agent`)
      forwardEnv.push(`PI_CODING_AGENT_DIR=${agentDir}`);
    for (const name of ["PI_CODING_AGENT_SESSION_DIR", "PI_SKIP_VERSION_CHECK"]) {
      const value = get(`env_${name}`);
      if (value) forwardEnv.push(`${name}=${value}`);
    }
    const loginPath = get("lpath");
    const serverEnv = [...(loginPath ? [`PATH=${loginPath}`] : []), ...locales.values()];
    return {
      hostName: get("host"),
      agentDir,
      nodePath: piKind === "node" ? get("node") : "",
      piCliPath: get("pi"),
      tmuxPath: get("tmux"),
      tmuxSocket: get("socket"),
      homeDir,
      piKind,
      loginPath,
      ...(tv ? { tmuxVersion: tv } : {}),
      forwardEnv,
      serverEnv,
      procsDir: `${agentDir}/forge/procs`,
    };
  }

  // ---------------- dashboard / chat ----------------

  async listSessions(): Promise<SessionsSnapshot> {
    const env = await this.ensureProbe();
    const nonce = makeNonce();
    const out = await this.run(listingScript(env.procsDir, `${env.agentDir}/forge.json`, nonce), {
      timeoutMs: 20_000,
    });
    const listing = parseListing(out, nonce);
    if (!listing.complete)
      throw new HostError("command-failed", "The session listing was cut short");
    return buildSnapshot(listing);
  }

  readChat(row: Pick<SessionRow, "sessionFile">, cursor?: SessionCursor): Promise<ChatUpdateEx> {
    if (!row.sessionFile)
      return Promise.reject(new HostError("not-found", "This session has no session file yet"));
    return this.chat.read(row.sessionFile, cursor);
  }

  // ---------------- start / resume ----------------

  private piArgv(env: HostEnvironmentDetails): string[] {
    return env.piKind === "node" ? [env.nodePath, env.piCliPath] : [env.piCliPath];
  }

  private expandHome(env: HostEnvironmentDetails, path: string | undefined): string {
    if (!path) return env.homeDir;
    if (path === "~") return env.homeDir;
    if (path.startsWith("~/")) return `${env.homeDir}/${path.slice(2)}`;
    return path;
  }

  private startError(err: string, started: StartedSession | undefined): HostError {
    const [, reason = "", ...rest] = err.split(" ");
    const detail = rest.join(" ");
    if (reason === "live")
      return new HostError("session-live", "This session is already open in another pi");
    if (reason === "file") return new HostError("not-found", "The session file is gone");
    if (reason === "cwd")
      return new HostError(
        "not-found",
        "The session's folder does not exist on the host; open it from the terminal",
      );
    if (reason === "tmux")
      return new HostError("command-failed", `tmux could not start the window: ${detail}`);
    const where = started ? ` (window ${started.windowId}, pane ${started.pane})` : "";
    if (reason === "draft") return new PaneBusyError("draft", DRAFT_MESSAGE);
    if (reason === "timeout")
      return new HostError(
        "command-failed",
        `pi started${where} but its prompt did not appear in time; the prompt was not sent`,
      );
    if (reason === "died")
      return new HostError("command-failed", `pi exited right after starting${where}`);
    if (reason === "paste")
      return new HostError(
        "command-failed",
        `pi started${where} but the prompt could not be pasted`,
      );
    return new HostError("command-failed", `Starting pi failed: ${err}`);
  }

  private parseStart(out: string, nonce: string, expectPaste: boolean): StartedSession {
    const lines = tagged(out, nonce);
    const ok = lines.find((line) => line.startsWith("OK "));
    const err = lines.find((line) => line.startsWith("ERR"));
    const started = ok ? parseStartedLine(ok.slice(3)) : undefined;
    if (err) throw this.startError(err, started);
    if (!started) throw new HostError("command-failed", "tmux did not report the new window");
    if (expectPaste && !lines.includes("PASTED"))
      throw new HostError(
        "command-failed",
        `pi started (pane ${started.pane}) but the prompt was not confirmed`,
      );
    return started;
  }

  async startSession(input: StartSessionInput): Promise<StartedSession> {
    const prompt = sanitizePrompt(input.prompt ?? "");
    const bytes = utf8ByteLength(prompt);
    if (bytes > MAX_PROMPT_BYTES)
      throw new HostError("prompt-too-large", `The prompt is over ${MAX_PROMPT_BYTES} bytes`);
    const env = await this.ensureProbe();
    const hasPrompt = prompt.trim().length > 0;
    // forge: over 8 KiB cannot go through tmux's argv; start empty, then paste once pi is ready.
    const large = hasPrompt && bytes > MAX_ARGV_PROMPT_BYTES;
    const argv = this.piArgv(env);
    if (input.model) argv.push("--model", input.model);
    if (input.thinking) argv.push("--thinking", input.thinking);
    // pi reads `@x` as a file argument even after `--`.
    if (hasPrompt && !large) argv.push("--", prompt.startsWith("@") ? ` ${prompt}` : prompt);
    const nonce = makeNonce();
    const timeoutMs = this.options.readyTimeoutMs ?? 30_000;
    const out = await this.run(
      startScript({
        nonce,
        tmux: env.tmuxPath,
        socket: env.tmuxSocket,
        cwd: this.expandHome(env, input.cwd),
        cwdFallbackHome: false,
        windowName: hasPrompt ? windowName(prompt) : "pi",
        env: env.forwardEnv,
        serverEnv: env.serverEnv,
        argv,
        ...(large ? { waitReady: { procsDir: env.procsDir, timeoutMs }, pasteStdin: true } : {}),
      }),
      {
        ...(large ? { stdin: base64EncodeText(prompt) } : {}),
        timeoutMs: timeoutMs + 30_000,
        mutating: true,
      },
    );
    return this.parseStart(out, nonce, large);
  }

  private async resume(
    env: HostEnvironmentDetails,
    row: Pick<SessionRow, "sessionId" | "sessionFile" | "cwd">,
    prompt?: string,
  ): Promise<StartedSession> {
    if (!row.sessionFile)
      throw new HostError("not-found", "This session has no session file to resume");
    const nonce = makeNonce();
    const timeoutMs = this.options.readyTimeoutMs ?? 30_000;
    const send = prompt !== undefined;
    const out = await this.run(
      startScript({
        nonce,
        tmux: env.tmuxPath,
        socket: env.tmuxSocket,
        cwd: this.expandHome(env, row.cwd),
        // With a prompt to paste, a missing folder is refused: pi would ask about it and swallow the paste.
        cwdFallbackHome: !send,
        windowName: "pi-resume",
        env: env.forwardEnv,
        serverEnv: env.serverEnv,
        // A resumed session restores its own model and thinking level: neither is passed.
        argv: [...this.piArgv(env), "--session", row.sessionFile],
        requireFile: row.sessionFile,
        refuseLive: { procsDir: env.procsDir, sessionId: row.sessionId },
        // Without a prompt, still wait (softly) for the registration, so a second resume finds it live.
        waitReady: send
          ? { procsDir: env.procsDir, sessionId: row.sessionId, timeoutMs }
          : {
              procsDir: env.procsDir,
              sessionId: row.sessionId,
              timeoutMs: Math.min(timeoutMs, SOFT_READY_MS),
              soft: true,
            },
        ...(send ? { pasteStdin: true } : {}),
      }),
      {
        ...(send ? { stdin: base64EncodeText(prompt) } : {}),
        timeoutMs: timeoutMs + 30_000,
        mutating: true,
      },
    );
    return this.parseStart(out, nonce, send);
  }

  /** The reopen in flight for this session, or a new one: never two pi processes for one session. */
  private reopenOnce(
    sessionId: string,
    make: () => Promise<Reopened>,
  ): { promise: Promise<Reopened>; joined: boolean } {
    const existing = this.reopening.get(sessionId);
    if (existing) return { promise: existing, joined: true };
    const promise = make();
    this.reopening.set(sessionId, promise);
    const clear = () => {
      if (this.reopening.get(sessionId) === promise) this.reopening.delete(sessionId);
    };
    promise.then(clear, clear);
    return { promise, joined: false };
  }

  /** Live elsewhere now? Else resume it (pasting `prompt` once ready, when given). */
  private async reopen(
    env: HostEnvironmentDetails,
    row: Pick<SessionRow, "sessionId" | "sessionFile" | "cwd">,
    prompt?: string,
  ): Promise<Reopened> {
    const snapshot = await this.listSessions();
    const live = snapshot.rows.find((r) => r.live && r.sessionId === row.sessionId);
    if (live) return { kind: "live", row: live };
    const closed = snapshot.rows.find((r) => r.sessionId === row.sessionId);
    const sessionFile = closed?.sessionFile ?? row.sessionFile;
    if (!sessionFile)
      throw prompt !== undefined
        ? new HostError(
            "session-closed",
            "This session is closed and has no session file to resume",
          )
        : new HostError("not-found", "This session has no session file to resume");
    const target = { sessionId: row.sessionId, sessionFile, cwd: closed?.cwd ?? row.cwd };
    try {
      const started = await this.resume(env, target, prompt);
      return { kind: "resumed", started, delivered: prompt !== undefined };
    } catch (error) {
      // The host refused: another pi has it open (started elsewhere a moment ago).
      if (!(error instanceof HostError) || error.code !== "session-live") throw error;
      const again = await this.listSessions();
      const now = again.rows.find((r) => r.live && r.sessionId === row.sessionId);
      if (now) return { kind: "live", row: now };
      throw error;
    }
  }

  async resumeSession(row: SessionRow): Promise<StartedSession> {
    if (row.live)
      throw new HostError("session-live", "This session is open; it cannot be resumed twice");
    const env = await this.ensureProbe();
    const { promise } = this.reopenOnce(row.sessionId, () => this.reopen(env, row));
    const result = await promise;
    if (result.kind === "live")
      throw new HostError("session-live", "This session is open in another pi");
    return result.started;
  }

  // ---------------- send / abort ----------------

  private targetOf(row: SessionRow): PaneTarget {
    if (!row.tmux || !row.pid)
      throw new HostError(
        "command-failed",
        "This session does not run in tmux; use its own terminal",
      );
    return { pid: row.pid, pane: row.tmux.pane, socket: row.tmux.socket, sessionId: row.sessionId };
  }

  private async paneCommand(
    kind: "send" | "abort",
    env: HostEnvironmentDetails,
    target: PaneTarget,
    opts: { stdin?: string; waitMs?: number } = {},
  ): Promise<string> {
    const nonce = makeNonce();
    const waitMs = opts.waitMs ?? 0;
    const input = {
      nonce,
      tmux: env.tmuxPath,
      socket: target.socket,
      pane: target.pane,
      pid: target.pid,
      sessionId: target.sessionId,
      procsDir: env.procsDir,
      waitMs,
    };
    const out = await this.run(kind === "send" ? sendScript(input) : abortScript(input), {
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      timeoutMs: 30_000 + 2 * waitMs,
      mutating: true,
    });
    return tagged(out, nonce)[0]?.trim() ?? "";
  }

  private sendResult(status: string): void {
    switch (status) {
      case "OK":
        return;
      case "WAITING":
        throw new HostError(
          "waiting-for-input",
          "pi is showing a dialog; answer it in the terminal first",
        );
      case "BUSY":
        throw new PaneBusyError(
          "copy-mode",
          "The pane is in copy mode; leave it (q) in the terminal first",
        );
      case "DRAFT":
        throw new PaneBusyError("draft", DRAFT_MESSAGE);
      case "NOPROMPT":
        throw new PaneBusyError(
          "no-prompt",
          "pi is not showing its prompt (a dialog or page is open); check the terminal first",
        );
      case "NOTMUX":
        throw new HostError(
          "command-failed",
          "This session does not run in tmux; use its own terminal",
        );
      case "GONE":
        throw new HostError("command-failed", "The session's tmux pane is gone");
      default:
        throw new HostError("command-failed", "Pasting into the pane failed");
    }
  }

  async sendPrompt(row: SessionRow, raw: string): Promise<void> {
    const text = sanitizePrompt(raw);
    if (!text.trim()) throw new HostError("command-failed", "Nothing to send");
    if (utf8ByteLength(text) > MAX_PROMPT_BYTES)
      throw new HostError("prompt-too-large", `The prompt is over ${MAX_PROMPT_BYTES} bytes`);
    const env = await this.ensureProbe();
    const stdin = base64EncodeText(text);
    let target: PaneTarget | undefined = row.live ? this.targetOf(row) : undefined;
    let waitMs = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (target) {
        const status = await this.paneCommand("send", env, target, { stdin, waitMs });
        if (status !== "CLOSED") return this.sendResult(status);
        if (waitMs > 0)
          throw new HostError(
            "session-closed",
            "pi exited right after the session was reopened; the prompt was not sent",
          );
      }
      // Closed (forge closes finished windows nobody views), or the process went away: is it open
      // elsewhere now? Else resume it and deliver the prompt there, so a follow-up is never lost.
      // A resume already in flight for this session is joined, never doubled.
      const { promise, joined } = this.reopenOnce(row.sessionId, () => this.reopen(env, row, text));
      const result = await promise;
      if (result.kind === "resumed") {
        if (!joined && result.delivered) return;
        // Joined someone else's resume: deliver this prompt to that pi once it shows its prompt.
        target = {
          pid: result.started.pid,
          pane: result.started.pane,
          socket: env.tmuxSocket,
          sessionId: row.sessionId,
        };
        waitMs = this.options.readyTimeoutMs ?? 30_000;
        continue;
      }
      if (target && result.row.pid === target.pid) break;
      target = this.targetOf(result.row);
      waitMs = 0;
    }
    throw new HostError("session-closed", "The session could not be reached");
  }

  async abort(row: SessionRow): Promise<void> {
    if (!row.live || !row.pid) throw new HostError("session-closed", "This session is closed");
    const target = this.targetOf(row);
    const key = `${target.socket}\n${target.pane}`;
    const now = this.now();
    const last = this.lastAbort.get(key);
    if (last !== undefined && now - last < ABORT_INTERVAL_MS) return;
    this.lastAbort.set(key, now);
    const env = await this.ensureProbe();
    const status = await this.paneCommand("abort", env, target);
    switch (status) {
      case "OK":
      case "IDLE":
        return;
      case "BUSY":
        throw new PaneBusyError(
          "copy-mode",
          "The pane is in copy mode; Escape would only leave it",
        );
      case "CLOSED":
        throw new HostError("session-closed", "This session is closed");
      default:
        throw new HostError("command-failed", "Could not send Escape to the pane");
    }
  }

  // ---------------- terminal ----------------

  terminalFor(row: SessionRow): TerminalAttachment {
    if (!row.live || !row.tmux)
      throw new HostError("session-closed", "This session has no live tmux pane");
    // Older (or unknown) tmux cannot attach with ignore-size: the phone would resize desktop windows.
    const support = terminalSupport(this.env?.tmuxVersion);
    if (!support.ok) throw new HostError("tmux-missing", TERMINAL_TMUX_MESSAGE);
    const tmux = this.env?.tmuxPath ?? "tmux";
    const sessionName = `pim-${row.tmux.pane.replace(/[^0-9]/g, "")}-${randomHex(6)}`;
    const target = { tmux, socket: row.tmux.socket };
    return {
      command: wrapForAnyShell(
        attachScript({
          ...target,
          pane: row.tmux.pane,
          sessionName,
          keepLast: support.keepLast,
          ignoreSize: true,
        }),
      ),
      cleanupCommand: wrapForAnyShell(attachCleanupScript({ ...target, sessionName })),
    };
  }
}

export function createHostService(
  connection: SshConnection,
  options?: HostServiceOptions,
): PiHostService {
  return new HostServiceImpl(connection, options);
}
