// SshClient over the PiSsh Expo module (modules/pi-ssh). The module is injected so this file has no
// native/Expo import and can be unit-tested with a fake; src/ssh/index.ts wires the real binding.

import type {
  PiSshConnectionCloseEvent,
  PiSshHostKeyEvent,
  PiSshNativeModule,
  PiSshShellCloseEvent,
  PiSshShellDataEvent,
  PiSshSubscription,
} from "../../modules/pi-ssh/src/PiSsh.types";
import { base64ToBytes, bytesToBase64, utf8Encode } from "./base64";
import { SSH_ERROR_CODES, SshError, toSshError } from "./errors";
import { ShellEvents } from "./shell-events";
import type {
  SshClient,
  SshConnectOptions,
  SshConnection,
  SshExecOptions,
  SshExecResult,
  SshShell,
  SshShellOptions,
  SshTarget,
} from "./types";

export interface NativeSshClientOptions {
  /** How long native waits for verifyHostKey before failing the connect. Default 120000. */
  hostKeyTimeoutMs?: number;
  /** SSH keepalive interval. Default 15000. */
  keepaliveIntervalMs?: number;
  /** Default connect timeout when SshConnectOptions.timeoutMs is absent. Default 20000. */
  defaultTimeoutMs?: number;
  /** Override id generation (tests). */
  createId?: (prefix: string) => string;
}

interface PendingConnect {
  verifyHostKey: SshConnectOptions["verifyHostKey"];
  asked: boolean;
  accepted: boolean;
}

interface ConnectionState {
  id: string;
  phase: "connecting" | "open" | "closed";
  closeListeners: Set<(error?: Error) => void>;
  shells: Set<string>;
}

interface ShellState {
  id: string;
  connectionId: string;
  events: ShellEvents;
}

let idCounter = 0;
function defaultCreateId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000_000;
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${rand}`;
}

function safeNotify(listener: (error?: Error) => void, error?: Error): void {
  try {
    listener(error);
  } catch (thrown) {
    setTimeout(() => {
      throw thrown;
    }, 0);
  }
}

export function createNativeSshClient(
  native: PiSshNativeModule,
  options: NativeSshClientOptions = {},
): SshClient {
  const createId = options.createId ?? defaultCreateId;
  const connections = new Map<string, ConnectionState>();
  const shells = new Map<string, ShellState>();
  const pendingConnects = new Map<string, PendingConnect>();
  let subscriptions: PiSshSubscription[] | null = null;

  function ensureSubscribed(): void {
    if (subscriptions) return;
    subscriptions = [
      native.addListener("onHostKey", handleHostKey),
      native.addListener("onShellData", handleShellData),
      native.addListener("onShellClose", handleShellClose),
      native.addListener("onConnectionClose", handleConnectionClose),
    ];
  }

  /** Drop native subscriptions once nothing is connecting or connected. */
  function maybeUnsubscribe(): void {
    if (!subscriptions) return;
    if (connections.size > 0 || pendingConnects.size > 0 || shells.size > 0) return;
    const subs = subscriptions;
    subscriptions = null;
    for (const sub of subs) sub.remove();
  }

  function respond(requestId: string, accept: boolean): void {
    try {
      native.respondHostKey(requestId, accept);
    } catch {
      // Request already timed out or connect was cancelled.
    }
  }

  function handleHostKey(event: PiSshHostKeyEvent): void {
    const pending = pendingConnects.get(event.connectionId);
    if (!pending) {
      respond(event.requestId, false);
      return;
    }
    if (pending.asked) {
      // verifyHostKey is called once per connect; a second prompt (re-key with another key) is refused.
      respond(event.requestId, false);
      return;
    }
    pending.asked = true;
    let decision: Promise<boolean>;
    try {
      decision = Promise.resolve(
        pending.verifyHostKey({ algorithm: event.algorithm, fingerprint: event.fingerprint }),
      );
    } catch {
      decision = Promise.resolve(false);
    }
    decision.then(
      (accept) => {
        const ok = accept === true;
        pending.accepted = ok;
        respond(event.requestId, ok);
        return ok;
      },
      () => {
        respond(event.requestId, false);
        return false;
      },
    );
  }

  function handleShellData(event: PiSshShellDataEvent): void {
    const shell = shells.get(event.shellId);
    if (!shell) return;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(event.data);
    } catch {
      return;
    }
    shell.events.pushData(bytes);
  }

  function finishShell(shellId: string, exitCode: number | null): void {
    const shell = shells.get(shellId);
    if (!shell) return;
    shells.delete(shellId);
    connections.get(shell.connectionId)?.shells.delete(shellId);
    shell.events.pushClose(exitCode);
  }

  function handleShellClose(event: PiSshShellCloseEvent): void {
    finishShell(event.shellId, typeof event.exitCode === "number" ? event.exitCode : null);
    maybeUnsubscribe();
  }

  function finishConnection(state: ConnectionState, error?: Error): void {
    if (state.phase === "closed") return;
    state.phase = "closed";
    connections.delete(state.id);
    for (const shellId of Array.from(state.shells)) finishShell(shellId, null);
    const listeners = [...state.closeListeners];
    state.closeListeners.clear();
    for (const listener of listeners) safeNotify(listener, error);
    maybeUnsubscribe();
  }

  function handleConnectionClose(event: PiSshConnectionCloseEvent): void {
    const state = connections.get(event.connectionId);
    if (!state) return;
    const error =
      event.reason === "lost"
        ? new SshError(SSH_ERROR_CODES.CONNECTION_CLOSED, "SSH connection lost")
        : undefined;
    finishConnection(state, error);
  }

  function makeShell(state: ShellState): SshShell {
    return {
      write(data: string | Uint8Array): void {
        if (state.events.isClosed || !shells.has(state.id)) return;
        const bytes = typeof data === "string" ? utf8Encode(data) : data;
        if (bytes.length === 0) return;
        native.write(state.id, bytesToBase64(bytes));
      },
      resize(cols: number, rows: number): void {
        if (state.events.isClosed || !shells.has(state.id)) return;
        const c = Math.floor(cols);
        const r = Math.floor(rows);
        if (!(c > 0) || !(r > 0)) return;
        native.resize(state.id, c, r);
      },
      onData: (listener) => state.events.onData(listener),
      onClose: (listener) => state.events.onClose(listener),
      close(): void {
        if (!shells.has(state.id)) return;
        native.closeShell(state.id);
        finishShell(state.id, null);
        maybeUnsubscribe();
      },
    };
  }

  function makeConnection(state: ConnectionState): SshConnection {
    return {
      async exec(command: string, execOptions?: SshExecOptions): Promise<SshExecResult> {
        if (state.phase !== "open") {
          throw new SshError(SSH_ERROR_CODES.NOT_CONNECTED, "Not connected");
        }
        try {
          const result = await native.exec(
            state.id,
            command,
            execOptions?.stdin ?? null,
            execOptions?.timeoutMs ?? null,
          );
          return {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
          };
        } catch (error) {
          throw toSshError(error, SSH_ERROR_CODES.EXEC_FAILED);
        }
      },

      async openShell(shellOptions: SshShellOptions): Promise<SshShell> {
        if (state.phase !== "open") {
          throw new SshError(SSH_ERROR_CODES.NOT_CONNECTED, "Not connected");
        }
        const shellId = createId("sh");
        const shell: ShellState = {
          id: shellId,
          connectionId: state.id,
          events: new ShellEvents(),
        };
        // Register before the native call so early output is buffered, not dropped.
        shells.set(shellId, shell);
        state.shells.add(shellId);
        try {
          await native.openShell({
            connectionId: state.id,
            shellId,
            cols: Math.max(1, Math.floor(shellOptions.cols)),
            rows: Math.max(1, Math.floor(shellOptions.rows)),
            term: shellOptions.term ?? "xterm-256color",
            ...(shellOptions.command !== undefined ? { command: shellOptions.command } : {}),
          });
        } catch (error) {
          shells.delete(shellId);
          state.shells.delete(shellId);
          throw toSshError(error, SSH_ERROR_CODES.SHELL_FAILED);
        }
        return makeShell(shell);
      },

      onClose(listener: (error?: Error) => void): () => void {
        if (state.phase === "closed") {
          queueMicrotask(() => safeNotify(listener));
          return () => {};
        }
        state.closeListeners.add(listener);
        return () => {
          state.closeListeners.delete(listener);
        };
      },

      isConnected(): boolean {
        if (state.phase !== "open") return false;
        try {
          return native.isConnected(state.id);
        } catch {
          return false;
        }
      },

      close(): void {
        if (state.phase === "closed") return;
        try {
          native.disconnect(state.id);
        } catch {
          // Already gone natively.
        }
        finishConnection(state);
      },
    };
  }

  return {
    async connect(target: SshTarget, connectOptions: SshConnectOptions): Promise<SshConnection> {
      ensureSubscribed();
      const id = createId("c");
      const pending: PendingConnect = {
        verifyHostKey: connectOptions.verifyHostKey,
        asked: false,
        accepted: false,
      };
      const state: ConnectionState = {
        id,
        phase: "connecting",
        closeListeners: new Set(),
        shells: new Set(),
      };
      pendingConnects.set(id, pending);
      connections.set(id, state);
      try {
        await native.connect({
          connectionId: id,
          host: target.host,
          port: target.port,
          username: target.username,
          ...(target.auth.type === "password"
            ? { password: target.auth.password }
            : {
                privateKey: target.auth.privateKey,
                ...(target.auth.passphrase ? { passphrase: target.auth.passphrase } : {}),
              }),
          timeoutMs: connectOptions.timeoutMs ?? options.defaultTimeoutMs ?? 20_000,
          hostKeyTimeoutMs: options.hostKeyTimeoutMs ?? 120_000,
          keepaliveIntervalMs: options.keepaliveIntervalMs ?? 15_000,
        });
      } catch (error) {
        pendingConnects.delete(id);
        state.phase = "closed";
        connections.delete(id);
        maybeUnsubscribe();
        throw toSshError(error, SSH_ERROR_CODES.CONNECT_FAILED);
      }
      pendingConnects.delete(id);
      if (!pending.accepted) {
        // Defensive: native must never authenticate without an explicit accept.
        try {
          native.disconnect(id);
        } catch {
          // ignore
        }
        state.phase = "closed";
        connections.delete(id);
        maybeUnsubscribe();
        throw new SshError(SSH_ERROR_CODES.HOST_KEY_REJECTED, "Host key was not verified");
      }
      if (state.phase === "closed") {
        // A connection-close event raced the connect resolution.
        throw new SshError(SSH_ERROR_CODES.CONNECTION_CLOSED, "Connection closed during connect");
      }
      state.phase = "open";
      return makeConnection(state);
    },

    async generateKeyPair(comment: string): Promise<{ privateKey: string; publicKey: string }> {
      try {
        const pair = await native.generateKeyPair(comment);
        return { privateKey: pair.privateKey, publicKey: pair.publicKey };
      } catch (error) {
        throw toSshError(error, SSH_ERROR_CODES.KEYGEN_FAILED);
      }
    },
  };
}
