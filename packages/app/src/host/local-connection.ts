// Test double: an SshConnection that runs commands on this machine the way sshd would
// (`$SHELL -c <command>`). Node only.

import { spawn, type ChildProcess } from "node:child_process";

import type { SshConnection, SshExecOptions, SshExecResult } from "@/ssh/types";

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
