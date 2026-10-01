// One SSH connection + host service per saved host: connect, TOFU prompt, probe, automatic
// reconnect with backoff. React-free; the app binds it in src/stores/app.ts.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { HostEnvironment, SavedHost } from "@/host/types";
import type { SshAuth, SshClient, SshConnection, SshHostKey } from "@/ssh/types";
import {
  classifyConnectionError,
  isConnectionLostError,
  isFatalFailure,
  type ConnectionFailure,
} from "./connection-errors";
import { realTimers, type Timers } from "./poller";
import { decideHostKey } from "./tofu";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

export interface HostConnectionState {
  status: ConnectionStatus;
  failure?: ConnectionFailure;
  env?: HostEnvironment;
  /** Reconnect attempts since the last success. */
  attempt: number;
}

export interface HostKeyPrompt {
  hostId: string;
  key: SshHostKey;
}

/** The part of PiHostService the connection layer needs. */
export interface ProbeableService {
  probe(): Promise<HostEnvironment>;
}

export interface ConnectionStoreDeps<S extends ProbeableService> {
  client: () => SshClient;
  createService: (connection: SshConnection) => S;
  getHost: (id: string) => SavedHost | undefined;
  loadAuth: (id: string) => Promise<SshAuth | null>;
  pinHostKey: (id: string, fingerprint: string) => Promise<void>;
  markConnected?: (id: string) => Promise<void>;
  timers?: Timers;
  /** Delay before reconnect attempt n (1-based). */
  reconnectDelayMs?: (attempt: number) => number;
  connectTimeoutMs?: number;
}

export interface ConnectOptions {
  /** Deliberate "Replace pinned key": accept exactly this fingerprint in place of the pin. */
  replaceKeyWith?: string;
}

export interface ConnectionState<S extends ProbeableService> {
  hosts: Record<string, HostConnectionState>;
  prompt: HostKeyPrompt | null;
  /** A person asked to connect: may prompt for an unknown key. Resolves null on failure. */
  connect(hostId: string, options?: ConnectOptions): Promise<S | null>;
  /** Connected service, or the connect in flight; starts one when idle. Never retries a failure. */
  ensureConnected(hostId: string): Promise<S | null>;
  getService(hostId: string): S | null;
  disconnect(hostId: string): void;
  /** A command failed; if the connection is gone, start reconnecting. */
  reportFailure(hostId: string, error: unknown): void;
  /** App came to the foreground: detect dead connections, retry pending reconnects now. */
  checkAll(): void;
  answerPrompt(accept: boolean): void;
}

export type ConnectionStore<S extends ProbeableService> = StoreApi<ConnectionState<S>>;

const IDLE: HostConnectionState = { status: "idle", attempt: 0 };

export function defaultReconnectDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

interface Live<S> {
  connection: SshConnection;
  service: S;
  unsubscribe: () => void;
}

interface Attempt {
  hostId: string;
  gen: number;
  interactive: boolean;
  replaceWith?: string;
  /** Set by verify: why the key was refused, or that the user declined. */
  keyOutcome?: "mismatch" | "unverified" | "declined";
  presented?: string;
  pinned?: string;
}

export function createConnectionStore<S extends ProbeableService>(
  deps: ConnectionStoreDeps<S>,
): ConnectionStore<S> {
  const timers = deps.timers ?? realTimers;
  const delayFor = deps.reconnectDelayMs ?? defaultReconnectDelay;
  const live = new Map<string, Live<S>>();
  const inflight = new Map<string, Promise<S | null>>();
  const generation = new Map<string, number>();
  const retryTimers = new Map<string, unknown>();
  let promptResolver: ((accept: boolean) => void) | null = null;

  return createStore<ConnectionState<S>>()((set, get) => {
    const stateOf = (hostId: string) => get().hosts[hostId] ?? IDLE;
    const patch = (hostId: string, next: Partial<HostConnectionState>) =>
      set((state) => ({ hosts: { ...state.hosts, [hostId]: { ...stateOf(hostId), ...next } } }));
    const genOf = (hostId: string) => generation.get(hostId) ?? 0;
    const isStale = (attempt: Attempt) => genOf(attempt.hostId) !== attempt.gen;

    const settlePrompt = (accept: boolean) => {
      const resolve = promptResolver;
      promptResolver = null;
      if (get().prompt) set({ prompt: null });
      resolve?.(accept);
    };

    const askTrust = (hostId: string, key: SshHostKey): Promise<boolean> => {
      if (promptResolver) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        promptResolver = resolve;
        set({ prompt: { hostId, key } });
      });
    };

    const clearRetry = (hostId: string) => {
      const timer = retryTimers.get(hostId);
      if (timer !== undefined) timers.clearTimeout(timer);
      retryTimers.delete(hostId);
    };

    const dropLive = (hostId: string) => {
      const entry = live.get(hostId);
      if (!entry) return;
      live.delete(hostId);
      entry.unsubscribe();
      try {
        entry.connection.close();
      } catch {
        // already closed
      }
    };

    const verify = async (attempt: Attempt, key: SshHostKey): Promise<boolean> => {
      const pinned = deps.getHost(attempt.hostId)?.hostKeyFingerprint;
      const decision = decideHostKey({
        pinned,
        presented: key.fingerprint,
        interactive: attempt.interactive,
        replaceWith: attempt.replaceWith,
      });
      attempt.presented = key.fingerprint;
      attempt.pinned = pinned;
      if (decision.action === "accept") return true;
      if (decision.action === "refuse") {
        attempt.keyOutcome = decision.reason === "mismatch" ? "mismatch" : "unverified";
        return false;
      }
      const accepted = decision.action === "replace" || (await askTrust(attempt.hostId, key));
      if (!accepted || isStale(attempt)) {
        attempt.keyOutcome = "declined";
        return false;
      }
      // Like OpenSSH's known_hosts: the key is pinned once accepted, before authentication.
      await deps.pinHostKey(attempt.hostId, key.fingerprint).catch(() => undefined);
      return true;
    };

    const failureFor = (attempt: Attempt, error: unknown): ConnectionFailure | null => {
      if (attempt.keyOutcome === "mismatch")
        return { kind: "host-key-mismatch", pinned: attempt.pinned, presented: attempt.presented };
      if (attempt.keyOutcome === "unverified") return { kind: "host-key-unverified" };
      if (attempt.keyOutcome === "declined") return null;
      return classifyConnectionError(error);
    };

    const scheduleRetry = (hostId: string) => {
      clearRetry(hostId);
      const attempt = stateOf(hostId).attempt + 1;
      patch(hostId, { status: "reconnecting", attempt });
      const gen = genOf(hostId);
      retryTimers.set(
        hostId,
        timers.setTimeout(() => {
          retryTimers.delete(hostId);
          if (genOf(hostId) === gen) void start(hostId, { interactive: false });
        }, delayFor(attempt)),
      );
    };

    const fail = (attempt: Attempt, failure: ConnectionFailure | null) => {
      const { hostId } = attempt;
      if (!failure) {
        patch(hostId, { status: "idle", failure: undefined, attempt: 0 });
        return;
      }
      if (!attempt.interactive && !isFatalFailure(failure.kind)) {
        patch(hostId, { failure });
        scheduleRetry(hostId);
        return;
      }
      patch(hostId, { status: "failed", failure, attempt: 0 });
    };

    const onLost = (hostId: string, gen: number) => {
      if (genOf(hostId) !== gen || inflight.has(hostId)) return;
      dropLive(hostId);
      patch(hostId, { status: "reconnecting", failure: { kind: "lost" }, attempt: 0 });
      scheduleRetry(hostId);
    };

    const finish = async (attempt: Attempt, connection: SshConnection): Promise<S | null> => {
      const { hostId, gen } = attempt;
      const service = deps.createService(connection);
      const unsubscribe = connection.onClose(() => onLost(hostId, gen));
      dropLive(hostId);
      live.set(hostId, { connection, service, unsubscribe });
      let env: HostEnvironment;
      try {
        env = await service.probe();
      } catch (error) {
        if (isStale(attempt)) return null;
        dropLive(hostId);
        fail(attempt, classifyConnectionError(error));
        return null;
      }
      if (isStale(attempt)) return null;
      clearRetry(hostId);
      patch(hostId, { status: "connected", env, failure: undefined, attempt: 0 });
      if (deps.markConnected) void deps.markConnected(hostId).catch(() => undefined);
      return service;
    };

    const runAttempt = async (attempt: Attempt): Promise<S | null> => {
      const { hostId } = attempt;
      const host = deps.getHost(hostId);
      if (!host) {
        fail({ ...attempt, interactive: true }, { kind: "unknown", message: "Unknown host" });
        return null;
      }
      if (attempt.interactive) patch(hostId, { status: "connecting", failure: undefined });
      const auth = await deps.loadAuth(hostId).catch(() => null);
      if (isStale(attempt)) return null;
      if (!auth) {
        fail({ ...attempt, interactive: true }, { kind: "missing-secret" });
        return null;
      }
      let connection: SshConnection;
      try {
        connection = await deps.client().connect(
          { host: host.host, port: host.port, username: host.username, auth },
          {
            verifyHostKey: (key) => verify(attempt, key),
            ...(deps.connectTimeoutMs ? { timeoutMs: deps.connectTimeoutMs } : {}),
          },
        );
      } catch (error) {
        if (get().prompt?.hostId === hostId) settlePrompt(false);
        if (isStale(attempt)) return null;
        fail(attempt, failureFor(attempt, error));
        return null;
      }
      if (isStale(attempt)) {
        connection.close();
        return null;
      }
      return finish(attempt, connection);
    };

    function start(
      hostId: string,
      options: { interactive: boolean; replaceWith?: string },
    ): Promise<S | null> {
      const existing = inflight.get(hostId);
      if (existing) return existing;
      const attempt: Attempt = { hostId, gen: genOf(hostId), ...options };
      const promise = runAttempt(attempt).finally(() => {
        if (inflight.get(hostId) === promise) inflight.delete(hostId);
      });
      inflight.set(hostId, promise);
      return promise;
    }

    const connectedService = (hostId: string): S | null => {
      const entry = live.get(hostId);
      if (!entry || stateOf(hostId).status !== "connected") return null;
      return entry.connection.isConnected() ? entry.service : null;
    };

    return {
      hosts: {},
      prompt: null,

      connect(hostId, options = {}) {
        if (!options.replaceKeyWith) {
          const service = connectedService(hostId);
          if (service) return Promise.resolve(service);
        }
        clearRetry(hostId);
        if (options.replaceKeyWith && !inflight.has(hostId)) dropLive(hostId);
        patch(hostId, { attempt: 0 });
        return start(hostId, { interactive: true, replaceWith: options.replaceKeyWith });
      },

      ensureConnected(hostId) {
        const service = connectedService(hostId);
        if (service) return Promise.resolve(service);
        const pending = inflight.get(hostId);
        if (pending) return pending;
        const status = stateOf(hostId).status;
        if (status === "failed" || status === "reconnecting") return Promise.resolve(null);
        return get().connect(hostId);
      },

      getService: (hostId) => connectedService(hostId),

      disconnect(hostId) {
        generation.set(hostId, genOf(hostId) + 1);
        clearRetry(hostId);
        inflight.delete(hostId);
        dropLive(hostId);
        if (get().prompt?.hostId === hostId) settlePrompt(false);
        set((state) => ({ hosts: { ...state.hosts, [hostId]: IDLE } }));
      },

      reportFailure(hostId, error) {
        const entry = live.get(hostId);
        if (!entry) return;
        if (!entry.connection.isConnected() || isConnectionLostError(error))
          onLost(hostId, genOf(hostId));
      },

      checkAll() {
        for (const [hostId, entry] of live) {
          if (!entry.connection.isConnected()) onLost(hostId, genOf(hostId));
        }
        const pending = Array.from(retryTimers.keys());
        for (const hostId of pending) {
          clearRetry(hostId);
          void start(hostId, { interactive: false });
        }
      },

      answerPrompt: (accept) => settlePrompt(accept),
    };
  });
}
