// Host service over SSH exec: native remote input for supported Forge sessions,
// tmux is used for opening sessions and aborting, never for sending prompt text.

import { hasRemote } from "@/remote/client";
import { CommandUnavailableError, RemoteError } from "@/remote/errors";
import { remoteFor } from "@/remote/for-service";
import { matchCommand } from "@/remote/menu";
import type { RemoteResult, RemoteState } from "@/remote/types";
import { SSH_ERROR_CODES } from "@/ssh/errors";
import type { SshConnection } from "@/ssh/types";

import { ChatReader, DEFAULT_CHAT_CAP, type ChatUpdateEx } from "./chat";
import {
  abortScript,
  listingScript,
  makeNonce,
  probeScript,
  startScript,
  windowName,
  wrapForAnyShell,
  wrapWithHostTimeout,
  parseStartedLine,
} from "./commands";
import { utf8ByteLength } from "./encoding";
import { DRAFT_MESSAGE, HostOutcomeUnknownError, PaneBusyError } from "./errors";
import { buildSnapshot, parseListing } from "./procs";
import { sanitizePrompt } from "./sanitize";
import {
  HostError,
  type HostEnvironment,
  type HostService,
  type RemoteSession,
  type SessionCursor,
  type SessionRow,
  type SessionsSnapshot,
  type StartSessionInput,
  type StartedSession,
} from "./types";

/** Native input's text cap; the complete escaped inbox JSON must also fit 64 KiB. */
export const MAX_PROMPT_BYTES = 60 * 1024;
export const ABORT_INTERVAL_MS = 1000;
/** A mutating script is killed on the host this many seconds before the phone's exec timeout. */
const HOST_TIMEOUT_MARGIN_S = 5;
/** Resume without a prompt: how long to wait for the new pi to register before returning. */
const SOFT_READY_MS = 15_000;

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
  /** The probed environment (probing once if needed); never re-probes a cached host. */
  environment(): Promise<HostEnvironmentDetails>;
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

type Reopened = { kind: "live"; row: SessionRow } | { kind: "resumed"; started: StartedSession };

class HostServiceImpl implements PiHostService {
  private env: HostEnvironmentDetails | undefined;
  private probing: Promise<HostEnvironmentDetails> | undefined;
  private readonly chat: ChatReader;
  private readonly lastAbort = new Map<string, number>();
  /** One start/resume in flight per sessionId: concurrent resumes and sends join it. */
  private readonly reopening = new Map<string, Promise<Reopened>>();
  private readonly ensuringRemote = new Map<string, Promise<RemoteSession>>();
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

  environment(): Promise<HostEnvironmentDetails> {
    return this.ensureProbe();
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
      return new HostError("not-found", "The session's folder does not exist on the host");
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
    // Start empty: even a new session may acquire a desktop draft during startup.
    const argv = this.piArgv(env);
    if (input.model) argv.push("--model", input.model);
    if (input.thinking) argv.push("--thinking", input.thinking);
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
        ...(hasPrompt ? { waitReady: { procsDir: env.procsDir, timeoutMs, soft: true } } : {}),
      }),
      {
        timeoutMs: timeoutMs + 30_000,
        mutating: true,
      },
    );
    const started = this.parseStart(out, nonce, false);
    if (hasPrompt) await this.sendPrompt(await this.registeredRow(started.pid), prompt);
    return started;
  }

  private async resume(
    env: HostEnvironmentDetails,
    row: Pick<SessionRow, "sessionId" | "sessionFile" | "cwd">,
    options: { requireCwd?: boolean },
  ): Promise<StartedSession> {
    if (!row.sessionFile)
      throw new HostError("not-found", "This session has no session file to resume");
    const nonce = makeNonce();
    const timeoutMs = this.options.readyTimeoutMs ?? 30_000;
    const out = await this.run(
      startScript({
        nonce,
        tmux: env.tmuxPath,
        socket: env.tmuxSocket,
        cwd: this.expandHome(env, row.cwd),
        // Sending must not silently change the session's working folder.
        cwdFallbackHome: !options.requireCwd,
        windowName: "pi-resume",
        env: env.forwardEnv,
        serverEnv: env.serverEnv,
        // A resumed session restores its own model and thinking level: neither is passed.
        argv: [...this.piArgv(env), "--session", row.sessionFile],
        requireFile: row.sessionFile,
        refuseLive: { procsDir: env.procsDir, sessionId: row.sessionId },
        // Without a prompt, still wait (softly) for the registration, so a second resume finds it live.
        waitReady: {
          procsDir: env.procsDir,
          sessionId: row.sessionId,
          timeoutMs: Math.min(timeoutMs, SOFT_READY_MS),
          soft: true,
        },
      }),
      {
        timeoutMs: timeoutMs + 30_000,
        mutating: true,
      },
    );
    return this.parseStart(out, nonce, false);
  }

  /** The reopen in flight for this session, or a new one: never two pi processes for one session. */
  private reopenOnce(sessionId: string, make: () => Promise<Reopened>): Promise<Reopened> {
    const existing = this.reopening.get(sessionId);
    if (existing) return existing;
    const promise = make();
    this.reopening.set(sessionId, promise);
    const clear = () => {
      if (this.reopening.get(sessionId) === promise) this.reopening.delete(sessionId);
    };
    promise.then(clear, clear);
    return promise;
  }

  /** Live elsewhere now? Else resume empty; explicit sends wait for the native channel. */
  private async reopen(
    env: HostEnvironmentDetails,
    row: Pick<SessionRow, "sessionId" | "sessionFile" | "cwd">,
    options: { requireCwd?: boolean } = {},
  ): Promise<Reopened> {
    const snapshot = await this.listSessions();
    const live = snapshot.rows.find((r) => r.live && r.sessionId === row.sessionId);
    if (live) return { kind: "live", row: live };
    const closed = snapshot.rows.find((r) => r.sessionId === row.sessionId);
    const sessionFile = closed?.sessionFile ?? row.sessionFile;
    if (!sessionFile)
      throw new HostError(
        "session-closed",
        "This session is closed and has no session file to resume",
      );
    const target = { sessionId: row.sessionId, sessionFile, cwd: closed?.cwd ?? row.cwd };
    try {
      const started = await this.resume(env, target, options);
      return { kind: "resumed", started };
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
    const promise = this.reopenOnce(row.sessionId, () => this.reopen(env, row));
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
        "This session does not run in tmux, so the app cannot reach it",
      );
    return { pid: row.pid, pane: row.tmux.pane, socket: row.tmux.socket, sessionId: row.sessionId };
  }

  private async abortPane(env: HostEnvironmentDetails, target: PaneTarget): Promise<string> {
    const nonce = makeNonce();
    const out = await this.run(
      abortScript({
        nonce,
        tmux: env.tmuxPath,
        socket: target.socket,
        pane: target.pane,
        pid: target.pid,
        sessionId: target.sessionId,
        procsDir: env.procsDir,
      }),
      { timeoutMs: 30_000, mutating: true },
    );
    return tagged(out, nonce)[0]?.trim() ?? "";
  }

  private async registeredRow(pid: number, sessionId?: string): Promise<SessionRow> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 30_000);
    do {
      const snapshot = await this.listSessions();
      const row = snapshot.rows.find((r) => r.live && r.pid === pid);
      if (row && sessionId !== undefined && row.sessionId !== sessionId)
        throw new HostError("session-closed", "The target session changed.");
      if (row && hasRemote(row)) return row;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw new HostError(
      "session-closed",
      "Forge's native input channel did not register after opening; the prompt was not sent. Update Forge and voluntarily reload this session on your computer.",
    );
  }

  private async readNativeState(
    row: SessionRow,
    deadline: number,
  ): Promise<RemoteState | undefined> {
    const client = remoteFor(this);
    let state = await client.readState(row);
    while (!state || state.input?.submit === false) {
      const snapshot = await this.listSessions();
      if (!snapshot.rows.some((r) => r.live && r.pid === row.pid && r.sessionId === row.sessionId))
        return undefined;
      if (Date.now() >= deadline)
        throw new HostError(
          "command-failed",
          "Forge's native input channel did not become ready; the prompt was not sent. Update Forge and voluntarily reload this session on your computer.",
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
      state = await client.readState(row);
    }
    return state;
  }

  /** Refresh the selected identity and share the same empty reopen with sends and commands. */
  private async liveRow(row: SessionRow): Promise<SessionRow> {
    const env = await this.ensureProbe();
    const snapshot = await this.listSessions();
    let live = snapshot.rows.find((r) => r.live && r.sessionId === row.sessionId);
    if (!live) {
      const result = await this.reopenOnce(row.sessionId, () =>
        this.reopen(env, row, { requireCwd: true }),
      );
      live =
        result.kind === "live"
          ? result.row
          : await this.registeredRow(result.started.pid, row.sessionId);
    }
    if (live.sessionId !== row.sessionId)
      throw new HostError("session-closed", "The target session changed.");
    if (!hasRemote(live)) throw new HostError("command-failed", DRAFT_MESSAGE);
    return live;
  }

  private async readyRemote(row: SessionRow): Promise<RemoteSession> {
    const state = await this.readNativeState(
      row,
      Date.now() + (this.options.readyTimeoutMs ?? 30_000),
    );
    if (!state || state.pid !== row.pid || state.sessionId !== row.sessionId)
      throw new HostError("session-closed", "The target session changed.");
    if (!state.input?.submit)
      throw new HostError(
        "command-failed",
        "Update Forge and voluntarily reload this session on your computer.",
      );
    return { row, state };
  }

  private validateCommand(state: RemoteState, line: string): void {
    if (!matchCommand(line, state.commands)) throw new CommandUnavailableError();
  }

  async ensureRemoteSession(row: SessionRow, line?: string): Promise<RemoteSession> {
    let promise = this.ensuringRemote.get(row.sessionId);
    if (!promise) {
      promise = this.liveRow(row).then((live) => this.readyRemote(live));
      this.ensuringRemote.set(row.sessionId, promise);
      const pending = promise;
      const clear = () => {
        if (this.ensuringRemote.get(row.sessionId) === pending)
          this.ensuringRemote.delete(row.sessionId);
      };
      promise.then(clear, clear);
    }
    const session = await promise;
    if (line !== undefined) this.validateCommand(session.state, line);
    return session;
  }

  async runCommand(row: SessionRow, line: string): Promise<RemoteResult> {
    let session = await this.ensureRemoteSession(row, line);
    for (let attempt = 0; ; attempt++) {
      try {
        return await remoteFor(this).send(
          session.row,
          "command.run",
          { line },
          {
            rev: session.state.rev,
            sessionId: row.sessionId,
          },
        );
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error;
        if (error.code === "stale" && attempt === 0) {
          // A definite preflight refusal only. Stay on this PID/identity; never reopen or
          // retarget an action after it may have run, and revalidate the fresh command list.
          session = await this.readyRemote(session.row);
          this.validateCommand(session.state, line);
          continue;
        }
        if (["transport", "timeout", "no-channel", "error"].includes(error.code))
          throw new HostOutcomeUnknownError(OUTCOME_UNKNOWN_MESSAGE);
        throw error;
      }
    }
  }

  private async sendNative(row: SessionRow, text: string): Promise<"OK" | "CLOSED"> {
    const client = remoteFor(this);
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 30_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = await this.readNativeState(row, deadline);
      if (!state) return "CLOSED";
      if (state.sessionId !== row.sessionId) return "CLOSED";
      if (!state.input?.submit)
        throw new HostError(
          "command-failed",
          "This Forge session lacks input.submit. Update Forge and voluntarily reload it on your computer; the desktop draft has not been touched.",
        );
      if (utf8ByteLength(text) > state.input.maxBytes)
        throw new HostError(
          "prompt-too-large",
          `Native sending accepts up to ${state.input.maxBytes} UTF-8 bytes; shorten the prompt.`,
        );
      try {
        await client.send(
          row,
          "input.submit",
          { text },
          { rev: state.rev, sessionId: row.sessionId },
        );
        return "OK";
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error;
        // Stale is a preflight refusal: nothing ran. Read fresh gates once, never retry an
        // accepted action (nor paste) after a timeout, missing result or dropped SSH exec.
        if (error.code === "stale" && attempt === 0) continue;
        if (["transport", "timeout", "no-channel"].includes(error.code) || error.code === "error")
          throw new HostOutcomeUnknownError(`${OUTCOME_UNKNOWN_MESSAGE} (${error.message})`);
        if (error.code === "invalid" && !error.result)
          throw new HostError("prompt-too-large", error.detail ?? error.message);
        if (error.code === "refused" && error.reason === "busy")
          throw new HostError("waiting-for-input", error.message);
        throw new HostError("command-failed", error.message);
      }
    }
    throw new HostError(
      "command-failed",
      "The session changed before sending; the prompt was not sent",
    );
  }

  async sendPrompt(row: SessionRow, raw: string): Promise<void> {
    const text = sanitizePrompt(raw);
    if (!text.trim()) throw new HostError("command-failed", "Nothing to send");
    if (utf8ByteLength(text) > MAX_PROMPT_BYTES)
      throw new HostError("prompt-too-large", `The prompt is over ${MAX_PROMPT_BYTES} bytes`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const live = await this.liveRow(row);
      const status = await this.sendNative(live, text);
      if (status === "OK") return;
    }
    throw new HostError(
      "session-closed",
      "The session could not be reached; the prompt was not sent",
    );
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
    const status = await this.abortPane(env, target);
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
}

export function createHostService(
  connection: SshConnection,
  options?: HostServiceOptions,
): PiHostService {
  return new HostServiceImpl(connection, options);
}
