// SshClient over the PiSsh Expo module (modules/pi-ssh). The module is injected so this file has no
// native/Expo import and can be unit-tested with a fake; src/ssh/index.ts wires the real binding.

import type {
  PiSshConnectionCloseEvent,
  PiSshHostKeyEvent,
  PiSshNativeModule,
  PiSshSubscription,
} from "../../modules/pi-ssh/src/PiSsh.types";
import { SSH_ERROR_CODES, SshError, toSshError } from "./errors";
import type {
  SshClient,
  SshConnectOptions,
  SshConnection,
  SshExecOptions,
  SshExecResult,
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
  const pendingConnects = new Map<string, PendingConnect>();
  let subscriptions: PiSshSubscription[] | null = null;

  function ensureSubscribed(): void {
    if (subscriptions) return;
    subscriptions = [
      native.addListener("onHostKey", handleHostKey),
      native.addListener("onConnectionClose", handleConnectionClose),
    ];
  }

  /** Drop native subscriptions once nothing is connecting or connected. */
  function maybeUnsubscribe(): void {
    if (!subscriptions) return;
    if (connections.size > 0 || pendingConnects.size > 0) return;
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

  function finishConnection(state: ConnectionState, error?: Error): void {
    if (state.phase === "closed") return;
    state.phase = "closed";
    connections.delete(state.id);
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
