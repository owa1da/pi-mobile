// HostService over one SshConnection. Every call is one `exec` of a POSIX sh script (see
// commands.ts) except probe (once, cached) and the resume-then-send path of sendPrompt.

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
} from "./commands";
import { base64EncodeText, utf8ByteLength } from "./encoding";
import { buildSnapshot, parseListing } from "./procs";
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

export interface HostServiceOptions {
  /** The agent dir (default: the login shell's PI_CODING_AGENT_DIR, else ~/.pi/agent). */
  agentDir?: string;
  /** The tmux socket for new sessions (default: the one live pi records name, else tmux's default). */
  tmuxSocket?: string;
  /** Resolve node/pi/tmux through the user's login shell (default true). */
  useLoginShell?: boolean;
  /** Bytes per chat read (default 1 MiB). */
  chatChunkBytes?: number;
  /** How long a resumed/started pi may take to register before a prompt is pasted (default 30 s). */
  readyTimeoutMs?: number;
  now?: () => number;
}

export interface HostEnvironmentDetails extends HostEnvironment {
  /** "node": run `nodePath piCliPath`; "exec": run `piCliPath` itself (a wrapper script). */
  piKind: "node" | "exec";
  /** PATH from the login shell, given to a tmux server this service starts. */
  loginPath: string;
  tmuxVersion?: [number, number];
  /** NAME=value pairs forwarded to new windows (forge's FORWARDED_ENV). */
  forwardEnv: string[];
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

function versionAtLeast(v: [number, number] | undefined, major: number, minor: number): boolean {
  if (!v) return true;
  return v[0] > major || (v[0] === major && v[1] >= minor);
}

function randomHex(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

class HostServiceImpl implements PiHostService {
  private env: HostEnvironmentDetails | undefined;
  private probing: Promise<HostEnvironmentDetails> | undefined;
  private readonly chat: ChatReader;
  private readonly lastAbort = new Map<string, number>();
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
    opts: { stdin?: string; timeoutMs?: number } = {},
  ): Promise<string> {
    let result;
    try {
      result = await this.connection.exec(wrapForAnyShell(script), {
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
        timeoutMs: opts.timeoutMs ?? 30_000,
      });
    } catch (error) {
      throw new HostError(
        "command-failed",
        `Host command failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    const kv = new Map<string, string>();
    for (const line of tagged(out, nonce)) {
      const eq = line.indexOf("=");
      if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1));
    }
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
    const tv = /(\d+)\.(\d+)/.exec(get("tmuxv"));
    const homeDir = get("home");
    const forwardEnv: string[] = [];
    const loginAgentDir = get("env_PI_CODING_AGENT_DIR");
    if (this.options.agentDir || loginAgentDir || agentDir !== `${homeDir}/.pi/agent`)
      forwardEnv.push(`PI_CODING_AGENT_DIR=${agentDir}`);
    for (const name of ["PI_CODING_AGENT_SESSION_DIR", "PI_SKIP_VERSION_CHECK"]) {
      const value = get(`env_${name}`);
      if (value) forwardEnv.push(`${name}=${value}`);
    }
    return {
      hostName: get("host"),
      agentDir,
      nodePath: piKind === "node" ? get("node") : "",
      piCliPath: get("pi"),
      tmuxPath: get("tmux"),
      tmuxSocket: get("socket"),
      homeDir,
      piKind,
      loginPath: get("lpath"),
      ...(tv ? { tmuxVersion: [Number(tv[1]), Number(tv[2])] as [number, number] } : {}),
      forwardEnv,
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

  private parseStart(out: string, nonce: string, expectPaste: boolean): StartedSession {
    const lines = tagged(out, nonce);
    const ok = lines.find((line) => line.startsWith("OK "));
    const err = lines.find((line) => line.startsWith("ERR"));
    let started: StartedSession | undefined;
    if (ok) {
      const [tmuxSession, windowId, pane, pid] = ok.slice(3).split("\t");
      if (tmuxSession !== undefined && windowId && pane && pid)
        started = { tmuxSession, windowId, pane, pid: Number(pid) };
    }
    if (err) {
      const [, reason = "", ...rest] = err.split(" ");
      const detail = rest.join(" ");
      if (reason === "file") throw new HostError("not-found", "The session file is gone");
      if (reason === "cwd")
        throw new HostError(
          "not-found",
          "The session's folder does not exist on the host; open it from the terminal",
        );
      if (reason === "tmux")
        throw new HostError("command-failed", `tmux could not start the window: ${detail}`);
      const where = started ? ` (window ${started.windowId}, pane ${started.pane})` : "";
      if (reason === "timeout")
        throw new HostError(
          "command-failed",
          `pi started${where} but did not register in time; the prompt was not sent`,
        );
      if (reason === "died")
        throw new HostError("command-failed", `pi exited right after starting${where}`);
      if (reason === "paste")
        throw new HostError(
          "command-failed",
          `pi started${where} but the prompt could not be pasted`,
        );
      throw new HostError("command-failed", `Starting pi failed: ${err}`);
    }
    if (!started) throw new HostError("command-failed", "tmux did not report the new window");
    if (expectPaste && !lines.includes("PASTED"))
      throw new HostError(
        "command-failed",
        `pi started (pane ${started.pane}) but the prompt was not confirmed`,
      );
    return started;
  }

  async startSession(input: StartSessionInput): Promise<StartedSession> {
    const prompt = input.prompt ?? "";
    if (prompt.includes("\0"))
      throw new HostError("command-failed", "The prompt contains a NUL character");
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
        serverPath: env.loginPath,
        argv,
        ...(large ? { waitReady: { procsDir: env.procsDir, timeoutMs }, pasteStdin: true } : {}),
      }),
      { ...(large ? { stdin: base64EncodeText(prompt) } : {}), timeoutMs: timeoutMs + 30_000 },
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
        serverPath: env.loginPath,
        // A resumed session restores its own model and thinking level: neither is passed.
        argv: [...this.piArgv(env), "--session", row.sessionFile],
        requireFile: row.sessionFile,
        ...(send
          ? {
              waitReady: { procsDir: env.procsDir, sessionId: row.sessionId, timeoutMs },
              pasteStdin: true,
            }
          : {}),
      }),
      { ...(send ? { stdin: base64EncodeText(prompt) } : {}), timeoutMs: timeoutMs + 30_000 },
    );
    return this.parseStart(out, nonce, send);
  }

  async resumeSession(row: SessionRow): Promise<StartedSession> {
    if (row.live)
      throw new HostError("session-live", "This session is open; it cannot be resumed twice");
    const env = await this.ensureProbe();
    const snapshot = await this.listSessions();
    if (snapshot.rows.some((r) => r.live && r.sessionId === row.sessionId))
      throw new HostError("session-live", "This session is open in another pi");
    return this.resume(env, row);
  }

  // ---------------- send / abort ----------------

  private async paneCommand(
    kind: "send" | "abort",
    env: HostEnvironmentDetails,
    row: SessionRow,
    stdin?: string,
  ): Promise<string> {
    if (!row.tmux || !row.pid)
      throw new HostError(
        "command-failed",
        "This session does not run in tmux; use its own terminal",
      );
    const nonce = makeNonce();
    const input = {
      nonce,
      tmux: env.tmuxPath,
      socket: row.tmux.socket,
      pane: row.tmux.pane,
      pid: row.pid,
      sessionId: row.sessionId,
      procsDir: env.procsDir,
    };
    const out = await this.run(
      kind === "send" ? sendScript(input) : abortScript(input),
      stdin !== undefined ? { stdin } : {},
    );
    return tagged(out, nonce)[0]?.trim() ?? "";
  }

  async sendPrompt(row: SessionRow, text: string): Promise<void> {
    if (!text.trim()) throw new HostError("command-failed", "Nothing to send");
    if (utf8ByteLength(text) > MAX_PROMPT_BYTES)
      throw new HostError("prompt-too-large", `The prompt is over ${MAX_PROMPT_BYTES} bytes`);
    const env = await this.ensureProbe();
    const stdin = base64EncodeText(text);
    let target: SessionRow | undefined = row.live ? row : undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (target) {
        const status = await this.paneCommand("send", env, target, stdin);
        switch (status) {
          case "OK":
            return;
          case "WAITING":
            throw new HostError(
              "waiting-for-input",
              "pi is showing a dialog; answer it in the terminal first",
            );
          case "BUSY":
            throw new HostError(
              "pane-busy",
              "The pane is in copy mode; leave it (q) in the terminal first",
            );
          case "NOTMUX":
            throw new HostError(
              "command-failed",
              "This session does not run in tmux; use its own terminal",
            );
          case "GONE":
            throw new HostError("command-failed", "The session's tmux pane is gone");
          case "CLOSED":
            break;
          default:
            throw new HostError("command-failed", "Pasting into the pane failed");
        }
      }
      // Closed (forge closes finished windows nobody views), or the process went away: is it open
      // elsewhere now? Else resume it and deliver the prompt there, so a follow-up is never lost.
      const snapshot = await this.listSessions();
      const live = snapshot.rows.find((r) => r.live && r.sessionId === row.sessionId);
      if (!live) {
        const closed = snapshot.rows.find((r) => r.sessionId === row.sessionId);
        const sessionFile = closed?.sessionFile ?? row.sessionFile;
        if (!sessionFile)
          throw new HostError(
            "session-closed",
            "This session is closed and has no session file to resume",
          );
        await this.resume(
          env,
          { sessionId: row.sessionId, sessionFile, cwd: closed?.cwd ?? row.cwd },
          text,
        );
        return;
      }
      if (target && live.pid === target.pid) break;
      target = live;
    }
    throw new HostError("session-closed", "The session could not be reached");
  }

  async abort(row: SessionRow): Promise<void> {
    if (!row.live || !row.pid) throw new HostError("session-closed", "This session is closed");
    if (!row.tmux)
      throw new HostError(
        "command-failed",
        "This session does not run in tmux; use its own terminal",
      );
    const key = `${row.tmux.socket}\n${row.tmux.pane}`;
    const now = this.now();
    const last = this.lastAbort.get(key);
    if (last !== undefined && now - last < ABORT_INTERVAL_MS) return;
    this.lastAbort.set(key, now);
    const env = await this.ensureProbe();
    const status = await this.paneCommand("abort", env, row);
    switch (status) {
      case "OK":
      case "IDLE":
        return;
      case "BUSY":
        throw new HostError("pane-busy", "The pane is in copy mode; Escape would only leave it");
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
    const tmux = this.env?.tmuxPath ?? "tmux";
    const version = this.env?.tmuxVersion;
    const sessionName = `pim-${row.tmux.pane.replace(/[^0-9]/g, "")}-${randomHex(6)}`;
    const target = { tmux, socket: row.tmux.socket };
    return {
      command: wrapForAnyShell(
        attachScript({
          ...target,
          pane: row.tmux.pane,
          sessionName,
          keepLast: versionAtLeast(version, 3, 4),
          ignoreSize: versionAtLeast(version, 3, 2),
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
