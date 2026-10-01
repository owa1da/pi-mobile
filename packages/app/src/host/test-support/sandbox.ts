// An isolated host for integration tests: temp HOME + agent dir (PI_CODING_AGENT_DIR), a fake
// `pi` on PATH, and a private tmux server (always `-S <tmp>/tmux/sock`). It never touches the
// user's tmux server, ~/.pi or real sessions. Node only.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LocalConnection } from "../local-connection";
import { createHostService, type HostServiceOptions, type PiHostService } from "../service";

export const FAKE_PI = path.resolve(__dirname, "fake-pi.mjs");

export interface FakeEvent {
  t: number;
  kind: "start" | "input" | "submit" | "escape" | "quit";
  argv?: string[];
  text?: string;
  pasted?: boolean;
  hex?: string;
  state?: string;
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
  pane?: string;
  agentEnv?: string | null;
}

export interface Sandbox {
  dir: string;
  home: string;
  agentDir: string;
  procsDir: string;
  socket: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  connection: LocalConnection;
  service(options?: HostServiceOptions): PiHostService;
  tmux(...args: string[]): string;
  events(pid: number): FakeEvent[];
  waitFor<T>(fn: () => T | undefined | false, timeoutMs?: number, label?: string): Promise<T>;
  /** The first event of the fake pi `pid` that matches, once it is logged. */
  waitForEvent(
    pid: number,
    predicate: (event: FakeEvent) => boolean,
    timeoutMs?: number,
    label?: string,
  ): Promise<FakeEvent>;
  cleanup(): void;
}

function which(name: string): string | undefined {
  try {
    return (
      execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export interface SandboxOptions {
  /** Put tmux on PATH (default true). */
  withTmux?: boolean;
  /** Put pi on PATH (default true). */
  withPi?: boolean;
  /** Create <agentDir>/forge/procs (default true). */
  withForge?: boolean;
}

/** Commands host scripts use; linked into a private bin so PATH can leave out tmux/pi on purpose. */
const TOOLS = [
  "sh",
  "base64",
  "sed",
  "grep",
  "head",
  "tail",
  "readlink",
  "realpath",
  "uname",
  "hostname",
  "date",
  "id",
  "sort",
  "uniq",
  "rm",
  "cut",
  "cat",
  "env",
  "timeout",
  "wc",
  "tr",
  "stat",
  "ls",
  "awk",
  "mkdir",
  "sleep",
  "kill",
  "ps",
  "printf",
  "echo",
  "test",
  "[",
  "script",
  "stty",
];

export function createSandbox(options: SandboxOptions = {}): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pim-host-"));
  const home = path.join(dir, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const procsDir = path.join(agentDir, "forge", "procs");
  const bin = path.join(dir, "bin");
  const tmuxDir = path.join(dir, "tmux");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(tmuxDir, { mode: 0o700 });
  if (options.withForge !== false) fs.mkdirSync(procsDir, { recursive: true, mode: 0o700 });
  else fs.mkdirSync(agentDir, { recursive: true });
  for (const tool of TOOLS) {
    const found = which(tool);
    if (found && found.startsWith("/")) fs.symlinkSync(found, path.join(bin, tool));
  }
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  if (options.withPi !== false) {
    fs.chmodSync(FAKE_PI, 0o755);
    fs.symlinkSync(FAKE_PI, path.join(bin, "pi"));
  }
  const tmuxPath = which("tmux");
  if (options.withTmux !== false && tmuxPath) fs.symlinkSync(tmuxPath, path.join(bin, "tmux"));
  else fs.rmSync(path.join(bin, "tmux"), { force: true });
  const socket = path.join(tmuxDir, "sock");
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    HOME: home,
    USER: os.userInfo().username,
    LOGNAME: os.userInfo().username,
    SHELL: "/bin/sh",
    PATH: bin,
    LANG: "C.UTF-8",
    TMUX_TMPDIR: tmuxDir,
    TMPDIR: dir,
    PI_CODING_AGENT_DIR: agentDir,
    FAKE_PI_DELAY_MS: "300",
  };
  const connection = new LocalConnection({ env, cwd: home });
  const tmux = (...args: string[]) =>
    execFileSync(tmuxPath ?? "tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      env: { ...env, PATH: `${bin}:/usr/bin:/bin` },
    });
  const sandbox: Sandbox = {
    dir,
    home,
    agentDir,
    procsDir,
    socket,
    bin,
    env,
    connection,
    service: (extra = {}) =>
      createHostService(connection, {
        agentDir,
        tmuxSocket: socket,
        useLoginShell: false,
        readyTimeoutMs: 15_000,
        ...extra,
      }),
    tmux,
    events(pid) {
      try {
        return fs
          .readFileSync(path.join(agentDir, "fake-pi", `${pid}.log`), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeEvent);
      } catch {
        return [];
      }
    },
    async waitFor(fn, timeoutMs = 10_000, label = "condition") {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = fn();
        if (value !== undefined && value !== false) return value as never;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    waitForEvent(pid, predicate, timeoutMs, label) {
      return sandbox.waitFor(() => sandbox.events(pid).find(predicate), timeoutMs, label);
    },
    cleanup() {
      connection.close();
      try {
        execFileSync(tmuxPath ?? "tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
      } catch {
        // no server
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return sandbox;
}
