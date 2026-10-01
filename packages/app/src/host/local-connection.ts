// Test double: an SshConnection that runs commands on this machine the way sshd would
// (`$SHELL -c <command>`). openShell allocates a pty with util-linux `script`. Node only.

import { spawn, type ChildProcess } from "node:child_process";

import type {
  SshConnection,
  SshExecOptions,
  SshExecResult,
  SshShell,
  SshShellOptions,
} from "@/ssh/types";

export interface LocalConnectionOptions {
  /** The whole environment of every command (default: process.env). */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export class LocalConnection implements SshConnection {
  private closed = false;
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private readonly children = new Set<ChildProcess>();

  constructor(private readonly options: LocalConnectionOptions = {}) {}

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private get shell(): string {
    return this.env.SHELL || "/bin/sh";
  }

  exec(command: string, options: SshExecOptions = {}): Promise<SshExecResult> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    return new Promise((resolve, reject) => {
      const child = spawn(this.shell, ["-c", command], {
        env: this.env,
        cwd: this.options.cwd ?? this.env.HOME,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.children.add(child);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (options.timeoutMs)
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`command timed out after ${options.timeoutMs} ms`));
        }, options.timeoutMs);
      child.stdout!.on("data", (d: Buffer) => out.push(d));
      child.stderr!.on("data", (d: Buffer) => err.push(d));
      child.on("error", (e) => {
        if (timer) clearTimeout(timer);
        this.children.delete(child);
        reject(e);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        this.children.delete(child);
        resolve({
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
          exitCode: code,
        });
      });
      child.stdin!.on("error", () => undefined);
      if (options.stdin !== undefined) child.stdin!.end(options.stdin);
      else child.stdin!.end();
    });
  }

  /** A pty via `script`; resize() is a no-op (the size is fixed at open). */
  openShell(options: SshShellOptions): Promise<SshShell> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const inner = `stty cols ${Math.floor(options.cols)} rows ${Math.floor(options.rows)} 2>/dev/null; ${
      options.command ?? 'exec "${SHELL:-/bin/sh}" -l'
    }`;
    const child = spawn("script", ["-qfec", inner, "/dev/null"], {
      env: { ...this.env, TERM: options.term ?? "xterm-256color" },
      cwd: this.options.cwd ?? this.env.HOME,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.add(child);
    const dataListeners = new Set<(bytes: Uint8Array) => void>();
    const closeListeners = new Set<(code: number | null) => void>();
    let exited = false;
    let exitCode: number | null = null;
    const onData = (d: Buffer) => {
      for (const l of dataListeners) l(new Uint8Array(d));
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.stdin!.on("error", () => undefined);
    child.on("close", (code) => {
      exited = true;
      exitCode = code;
      this.children.delete(child);
      for (const l of closeListeners) l(code);
    });
    const shell: SshShell = {
      write(data) {
        if (!exited) child.stdin!.write(typeof data === "string" ? data : Buffer.from(data));
      },
      resize() {
        // `script` gives no handle on its pty size after start.
      },
      onData(listener) {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onClose(listener) {
        if (exited) queueMicrotask(() => listener(exitCode));
        else closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close() {
        if (!exited) child.kill("SIGHUP");
      },
    };
    return new Promise((resolve, reject) => {
      child.once("spawn", () => resolve(shell));
      child.once("error", reject);
    });
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  isConnected(): boolean {
    return !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const child of this.children) child.kill("SIGHUP");
    this.children.clear();
    for (const l of this.closeListeners) l();
  }
}
