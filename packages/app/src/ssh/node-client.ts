// SshClient over the `ssh2` npm package, for Node-side tests (integration tests of the host
// service, etc.). Same semantics as the native client. NEVER import this from app code: it pulls in
// Node built-ins. App code uses getSshClient() from "./index".

import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import type { ClientChannel, ConnectConfig } from "ssh2";
import { SSH_ERROR_CODES, SshError } from "./errors";
import { ShellEvents } from "./shell-events";
import type {
  SshClient,
  SshConnectOptions,
  SshConnection,
  SshExecOptions,
  SshExecResult,
  SshHostKey,
  SshShell,
  SshShellOptions,
  SshTarget,
} from "./types";

const { Client, utils } = ssh2;

/** Same host key algorithm preference as the native client, so both see the same fingerprint. */
const SERVER_HOST_KEY_ALGORITHMS = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-512",
  "rsa-sha2-256",
] as const;

/** "SHA256:<unpadded base64>" exactly as printed by `ssh-keygen -lf`. */
export function hostKeyFingerprint(blob: Uint8Array): string {
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

export function hostKeyAlgorithm(blob: Uint8Array): string {
  if (blob.length < 4) return "unknown";
  const len = ((blob[0] << 24) | (blob[1] << 16) | (blob[2] << 8) | blob[3]) >>> 0;
  if (len === 0 || len > blob.length - 4) return "unknown";
  return Buffer.from(blob.subarray(4, 4 + len)).toString("ascii");
}

function onceListener<T>(set: Set<(value: T) => void>, value: T): void {
  const listeners = [...set];
  set.clear();
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      setTimeout(() => {
        throw error;
      }, 0);
    }
  }
}

export interface NodeSshClientOptions {
  keepaliveIntervalMs?: number;
  defaultTimeoutMs?: number;
}

export function createNodeSshClient(clientOptions: NodeSshClientOptions = {}): SshClient {
  return {
    connect(target: SshTarget, options: SshConnectOptions): Promise<SshConnection> {
      return new Promise<SshConnection>((resolve, reject) => {
        const client = new Client();
        let settled = false;
        let ready = false;
        let hostKeyAsked = false;
        let hostKeyAccepted = false;
        let hostKeyRejected = false;
        let closed = false;
        let closeError: Error | undefined;
        const closeListeners = new Set<(error?: Error) => void>();
        const openShells = new Set<() => void>();

        const fail = (error: SshError) => {
          if (settled) return;
          settled = true;
          client.end();
          reject(error);
        };

        const config: ConnectConfig = {
          host: target.host,
          port: target.port,
          username: target.username,
          readyTimeout: options.timeoutMs ?? clientOptions.defaultTimeoutMs ?? 20_000,
          keepaliveInterval: clientOptions.keepaliveIntervalMs ?? 15_000,
          keepaliveCountMax: 3,
          algorithms: { serverHostKey: [...SERVER_HOST_KEY_ALGORITHMS] },
          hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
            if (hostKeyAsked) {
              // Re-key: only the key accepted at connect time is allowed (ssh2 calls this once though).
              verify(false);
              return;
            }
            hostKeyAsked = true;
            const hostKey: SshHostKey = {
              algorithm: hostKeyAlgorithm(key),
              fingerprint: hostKeyFingerprint(key),
            };
            let decision: Promise<boolean>;
            try {
              decision = Promise.resolve(options.verifyHostKey(hostKey));
            } catch {
              decision = Promise.resolve(false);
            }
            decision.then(
              (accept) => {
                hostKeyAccepted = accept === true;
                hostKeyRejected = !hostKeyAccepted;
                verify(hostKeyAccepted);
                return hostKeyAccepted;
              },
              () => {
                hostKeyRejected = true;
                verify(false);
                return false;
              },
            );
          },
        };
        if (target.auth.type === "key") {
          config.privateKey = target.auth.privateKey;
          if (target.auth.passphrase) config.passphrase = target.auth.passphrase;
          config.authHandler = ["publickey"];
        } else {
          config.password = target.auth.password;
          config.tryKeyboard = true;
          const password = target.auth.password;
          let kbdAnswered = false;
          client.on("keyboard-interactive", (_name, _instr, _lang, prompts, finish) => {
            if (kbdAnswered || prompts.length !== 1 || prompts[0].echo) {
              finish([]);
              return;
            }
            kbdAnswered = true;
            finish([password]);
          });
          config.authHandler = ["password", "keyboard-interactive"];
        }

        client.on("ready", () => {
          if (!hostKeyAccepted) {
            fail(new SshError(SSH_ERROR_CODES.HOST_KEY_REJECTED, "Host key was not verified"));
            return;
          }
          ready = true;
          settled = true;
          resolve(connection);
        });

        client.on("error", (error: Error & { level?: string }) => {
          if (!settled) {
            if (hostKeyRejected) {
              fail(
                new SshError(
                  SSH_ERROR_CODES.HOST_KEY_REJECTED,
                  "Host key rejected; not authenticating",
                  { cause: error },
                ),
              );
            } else if (error.level === "client-authentication") {
              fail(
                new SshError(SSH_ERROR_CODES.AUTH_FAILED, "Authentication failed", {
                  cause: error,
                }),
              );
            } else if (error.level === "client-timeout" || /timed out/i.test(error.message)) {
              fail(
                new SshError(SSH_ERROR_CODES.TIMEOUT, `Connection timed out: ${error.message}`, {
                  cause: error,
                }),
              );
            } else if (
              /privateKey|parse|passphrase/i.test(error.message) &&
              target.auth.type === "key"
            ) {
              fail(
                new SshError(
                  SSH_ERROR_CODES.INVALID_KEY,
                  `Invalid private key or wrong passphrase: ${error.message}`,
                  { cause: error },
                ),
              );
            } else {
              fail(new SshError(SSH_ERROR_CODES.CONNECT_FAILED, error.message, { cause: error }));
            }
            return;
          }
          if (ready)
            closeError = new SshError(
              SSH_ERROR_CODES.CONNECTION_CLOSED,
              `SSH connection lost: ${error.message}`,
              { cause: error },
            );
        });

        client.on("close", () => {
          if (!settled) {
            if (hostKeyRejected) {
              fail(
                new SshError(
                  SSH_ERROR_CODES.HOST_KEY_REJECTED,
                  "Host key rejected; not authenticating",
                ),
              );
            } else {
              fail(
                new SshError(SSH_ERROR_CODES.CONNECT_FAILED, "Connection closed during handshake"),
              );
            }
            return;
          }
          markClosed(closeError);
        });

        function markClosed(error?: Error): void {
          if (closed) return;
          closed = true;
          for (const finishShell of Array.from(openShells)) finishShell();
          onceListener(closeListeners, error);
        }

        function requireOpen(): void {
          if (closed || !ready) throw new SshError(SSH_ERROR_CODES.NOT_CONNECTED, "Not connected");
        }

        const connection: SshConnection = {
          exec(command: string, execOptions?: SshExecOptions): Promise<SshExecResult> {
            try {
              requireOpen();
            } catch (error) {
              return Promise.reject(error);
            }
            return new Promise<SshExecResult>((resolveExec, rejectExec) => {
              client.exec(command, (error, stream) => {
                if (error) {
                  rejectExec(
                    new SshError(
                      closed ? SSH_ERROR_CODES.CONNECTION_CLOSED : SSH_ERROR_CODES.EXEC_FAILED,
                      error.message,
                      { cause: error },
                    ),
                  );
                  return;
                }
                const out: Buffer[] = [];
                const err: Buffer[] = [];
                let exitCode: number | null = null;
                let timedOut = false;
                let done = false;
                const timer =
                  execOptions?.timeoutMs && execOptions.timeoutMs > 0
                    ? setTimeout(() => {
                        timedOut = true;
                        stream.close();
                      }, execOptions.timeoutMs)
                    : null;
                const onConnClose = () => finish();
                closeListeners.add(onConnClose);
                function finish(): void {
                  if (done) return;
                  done = true;
                  if (timer) clearTimeout(timer);
                  closeListeners.delete(onConnClose);
                  if (timedOut) {
                    rejectExec(
                      new SshError(
                        SSH_ERROR_CODES.TIMEOUT,
                        `Command timed out after ${execOptions?.timeoutMs}ms`,
                      ),
                    );
                  } else if (closed && exitCode === null) {
                    rejectExec(
                      new SshError(
                        SSH_ERROR_CODES.CONNECTION_CLOSED,
                        "Connection closed while the command was running",
                      ),
                    );
                  } else {
                    resolveExec({
                      stdout: Buffer.concat(out).toString("utf8"),
                      stderr: Buffer.concat(err).toString("utf8"),
                      exitCode,
                    });
                  }
                }
                stream.on("data", (chunk: Buffer) => out.push(chunk));
                stream.stderr.on("data", (chunk: Buffer) => err.push(chunk));
                stream.on("exit", (code: number | null) => {
                  exitCode = typeof code === "number" ? code : null;
                });
                stream.on("close", () => finish());
                if (execOptions?.stdin !== undefined && execOptions.stdin.length > 0) {
                  stream.end(execOptions.stdin, "utf8");
                } else {
                  stream.end();
                }
              });
            });
          },

          openShell(shellOptions: SshShellOptions): Promise<SshShell> {
            try {
              requireOpen();
            } catch (error) {
              return Promise.reject(error);
            }
            const pty = {
              rows: Math.max(1, Math.floor(shellOptions.rows)),
              cols: Math.max(1, Math.floor(shellOptions.cols)),
              height: Math.max(1, Math.floor(shellOptions.rows)) * 16,
              width: Math.max(1, Math.floor(shellOptions.cols)) * 8,
              term: shellOptions.term ?? "xterm-256color",
            };
            return new Promise<SshShell>((resolveShell, rejectShell) => {
              const onStream = (error: Error | undefined, stream: ClientChannel) => {
                if (error) {
                  rejectShell(
                    new SshError(
                      closed ? SSH_ERROR_CODES.CONNECTION_CLOSED : SSH_ERROR_CODES.SHELL_FAILED,
                      error.message,
                      { cause: error },
                    ),
                  );
                  return;
                }
                const events = new ShellEvents();
                let exitCode: number | null = null;
                const finishShell = () => {
                  openShells.delete(finishShell);
                  events.pushClose(exitCode);
                };
                openShells.add(finishShell);
                stream.on("data", (chunk: Buffer) => events.pushData(new Uint8Array(chunk)));
                stream.stderr.on("data", (chunk: Buffer) => events.pushData(new Uint8Array(chunk)));
                stream.on("exit", (code: number | null) => {
                  exitCode = typeof code === "number" ? code : null;
                });
                stream.on("close", finishShell);
                stream.on("error", () => {});
                resolveShell({
                  write(data: string | Uint8Array): void {
                    if (events.isClosed) return;
                    stream.write(
                      typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data),
                    );
                  },
                  resize(cols: number, rows: number): void {
                    if (events.isClosed) return;
                    const c = Math.floor(cols);
                    const r = Math.floor(rows);
                    if (!(c > 0) || !(r > 0)) return;
                    stream.setWindow(r, c, r * 16, c * 8);
                  },
                  onData: (listener) => events.onData(listener),
                  onClose: (listener) => events.onClose(listener),
                  close(): void {
                    if (events.isClosed) return;
                    exitCode = null;
                    finishShell();
                    stream.close();
                  },
                });
              };
              if (shellOptions.command !== undefined) {
                client.exec(shellOptions.command, { pty }, onStream);
              } else {
                client.shell(pty, onStream);
              }
            });
          },

          onClose(listener: (error?: Error) => void): () => void {
            if (closed) {
              queueMicrotask(() => listener(closeError));
              return () => {};
            }
            closeListeners.add(listener);
            return () => {
              closeListeners.delete(listener);
            };
          },

          isConnected(): boolean {
            return ready && !closed;
          },

          close(): void {
            if (closed) return;
            client.end();
            markClosed();
          },
        };

        try {
          client.connect(config);
        } catch (error) {
          fail(
            new SshError(
              target.auth.type === "key"
                ? SSH_ERROR_CODES.INVALID_KEY
                : SSH_ERROR_CODES.CONNECT_FAILED,
              error instanceof Error ? error.message : String(error),
              { cause: error },
            ),
          );
        }
      });
    },

    async generateKeyPair(comment: string): Promise<{ privateKey: string; publicKey: string }> {
      const pair = utils.generateKeyPairSync("ed25519", { comment });
      return {
        privateKey: pair.private.endsWith("\n") ? pair.private : pair.private + "\n",
        publicKey: pair.public.trim(),
      };
    },
  };
}
