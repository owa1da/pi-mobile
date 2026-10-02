import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostError, type HostEnvironment, type SavedHost } from "@/host/types";
import { SSH_ERROR_CODES, SshError } from "@/ssh/errors";
import type { SshClient, SshConnection, SshConnectOptions, SshTarget } from "@/ssh/types";
import { createConnectionStore, type ProbeableService } from "./connection-store";

const ENV: HostEnvironment = {
  hostName: "box",
  agentDir: "/home/me/.pi/agent",
  nodePath: "/usr/bin/node",
  piCliPath: "/usr/lib/pi/cli.js",
  tmuxPath: "/usr/bin/tmux",
  tmuxSocket: "/tmp/tmux-1000/default",
  homeDir: "/home/me",
};

class FakeConnection implements SshConnection {
  connected = true;
  closed = 0;
  private listeners: Array<(error?: Error) => void> = [];
  exec = vi.fn();
  onClose(listener: (error?: Error) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  isConnected() {
    return this.connected;
  }
  close() {
    this.closed += 1;
    this.connected = false;
  }
  /** The network dropped. */
  lose() {
    this.connected = false;
    for (const listener of this.listeners)
      listener(new SshError("ERR_SSH_CONNECTION_CLOSED", "lost"));
  }
}

type Step = "ok" | Error;

function fakeClient(fingerprint: () => string, steps: Step[], gateFirst?: Promise<void>) {
  const connections: FakeConnection[] = [];
  let calls = 0;
  const client: SshClient = {
    async connect(_target: SshTarget, options: SshConnectOptions) {
      calls += 1;
      if (calls === 1 && gateFirst) await gateFirst;
      const accepted = await options.verifyHostKey({
        algorithm: "ssh-ed25519",
        fingerprint: fingerprint(),
      });
      if (!accepted) throw new SshError(SSH_ERROR_CODES.HOST_KEY_REJECTED, "rejected");
      const step = steps.shift() ?? "ok";
      if (step instanceof Error) throw step;
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
    generateKeyPair: () => Promise.resolve({ privateKey: "k", publicKey: "p" }),
  };
  return { client, connections };
}

function setup(
  options: {
    pinned?: string;
    steps?: Step[];
    probe?: () => Promise<HostEnvironment>;
    gateFirst?: Promise<void>;
  } = {},
) {
  let presented = "SHA256:aaaa";
  const host: SavedHost = {
    id: "h1",
    label: "Box",
    host: "box",
    port: 22,
    username: "me",
    authType: "key",
    secretRef: "h1",
    createdAt: 0,
    ...(options.pinned ? { hostKeyFingerprint: options.pinned } : {}),
  };
  const { client, connections } = fakeClient(
    () => presented,
    options.steps ?? [],
    options.gateFirst,
  );
  const pinHostKey = vi.fn((_id: string, fp: string) => {
    host.hostKeyFingerprint = fp;
    return Promise.resolve();
  });
  const probe = vi.fn(options.probe ?? (() => Promise.resolve(ENV)));
  const store = createConnectionStore<ProbeableService>({
    client: () => client,
    createService: () => ({ probe }),
    getHost: (id) => (id === "h1" ? host : undefined),
    loadAuth: () => Promise.resolve({ type: "key", privateKey: "k" }),
    pinHostKey,
    reconnectDelayMs: () => 1000,
  });
  return {
    store,
    host,
    connections,
    pinHostKey,
    probe,
    present: (fp: string) => {
      presented = fp;
    },
  };
}

const status = (s: ReturnType<typeof setup>) => s.store.getState().hosts.h1?.status;

describe("connection store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks on first use, pins the accepted key, probes and connects", async () => {
    const s = setup();
    const pending = s.store.getState().connect("h1");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.store.getState().prompt).toMatchObject({
      hostId: "h1",
      key: { fingerprint: "SHA256:aaaa" },
    });
    expect(status(s)).toBe("connecting");
    s.store.getState().answerPrompt(true);
    const service = await pending;
    expect(service).not.toBeNull();
    expect(s.pinHostKey).toHaveBeenCalledWith("h1", "SHA256:aaaa");
    expect(s.probe).toHaveBeenCalledTimes(1);
    expect(status(s)).toBe("connected");
    expect(s.store.getState().hosts.h1?.env?.hostName).toBe("box");
    expect(s.store.getState().getService("h1")).toBe(service);
  });

  it("declining the key returns to idle without pinning", async () => {
    const s = setup();
    const pending = s.store.getState().connect("h1");
    await vi.advanceTimersByTimeAsync(0);
    s.store.getState().answerPrompt(false);
    expect(await pending).toBeNull();
    expect(s.pinHostKey).not.toHaveBeenCalled();
    expect(status(s)).toBe("idle");
    expect(s.store.getState().prompt).toBeNull();
  });

  it("refuses a changed key with both fingerprints, and replaces only deliberately", async () => {
    const s = setup({ pinned: "SHA256:aaaa" });
    s.present("SHA256:bbbb");
    expect(await s.store.getState().connect("h1")).toBeNull();
    expect(status(s)).toBe("failed");
    expect(s.store.getState().hosts.h1?.failure).toEqual({
      kind: "host-key-mismatch",
      pinned: "SHA256:aaaa",
      presented: "SHA256:bbbb",
    });
    expect(s.pinHostKey).not.toHaveBeenCalled();

    const replaced = await s.store.getState().connect("h1", { replaceKeyWith: "SHA256:bbbb" });
    expect(replaced).not.toBeNull();
    expect(s.pinHostKey).toHaveBeenCalledWith("h1", "SHA256:bbbb");
    expect(status(s)).toBe("connected");
  });

  it("surfaces a host key that could not be pinned instead of connecting", async () => {
    const s = setup();
    s.pinHostKey.mockImplementationOnce(() => Promise.reject(new Error("keystore locked")));
    const pending = s.store.getState().connect("h1");
    await vi.advanceTimersByTimeAsync(0);
    s.store.getState().answerPrompt(true);
    expect(await pending).toBeNull();
    expect(status(s)).toBe("failed");
    expect(s.store.getState().hosts.h1?.failure).toMatchObject({ kind: "unknown" });
    expect(s.store.getState().hosts.h1?.failure?.message).toContain("keystore locked");
    expect(s.connections).toHaveLength(0);
    expect(s.probe).not.toHaveBeenCalled();
  });

  it("Replace pinned key during a connect in flight cancels it and reconnects with the new key", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = setup({ pinned: "SHA256:aaaa", gateFirst: gate });
    s.present("SHA256:bbbb");
    const first = s.store.getState().connect("h1");
    await vi.advanceTimersByTimeAsync(0);
    const second = s.store.getState().connect("h1", { replaceKeyWith: "SHA256:bbbb" });
    expect(second).not.toBe(first);
    expect(await second).not.toBeNull();
    expect(s.pinHostKey).toHaveBeenCalledWith("h1", "SHA256:bbbb");
    expect(status(s)).toBe("connected");
    release();
    expect(await first).toBeNull();
    // The cancelled attempt neither fails the host nor replaces the live connection.
    expect(status(s)).toBe("connected");
    expect(s.store.getState().hosts.h1?.failure).toBeUndefined();
    expect(s.connections.filter((c) => c.connected)).toHaveLength(1);
    expect(s.probe).toHaveBeenCalledTimes(1);
  });

  it("maps auth failure and missing pi to failed states without retrying", async () => {
    const s = setup({
      pinned: "SHA256:aaaa",
      steps: [new SshError(SSH_ERROR_CODES.AUTH_FAILED, "denied")],
    });
    await s.store.getState().connect("h1");
    expect(s.store.getState().hosts.h1?.failure?.kind).toBe("auth");

    const t = setup({
      pinned: "SHA256:aaaa",
      probe: () => Promise.reject(new HostError("pi-missing", "no pi")),
    });
    await t.store.getState().connect("h1");
    expect(status(t)).toBe("failed");
    expect(t.store.getState().hosts.h1?.failure?.kind).toBe("pi-missing");
    expect(t.connections[0]?.closed).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.probe).toHaveBeenCalledTimes(1);
  });

  it("reconnects automatically after a lost connection, with backoff, without prompting", async () => {
    const s = setup({
      pinned: "SHA256:aaaa",
      steps: ["ok", new SshError(SSH_ERROR_CODES.CONNECT_FAILED, "unreachable"), "ok"],
    });
    await s.store.getState().connect("h1");
    s.connections[0]?.lose();
    expect(status(s)).toBe("reconnecting");
    expect(s.store.getState().hosts.h1?.failure?.kind).toBe("lost");
    expect(s.store.getState().getService("h1")).toBeNull();

    await vi.advanceTimersByTimeAsync(1000); // attempt 1: unreachable
    expect(status(s)).toBe("reconnecting");
    expect(s.store.getState().hosts.h1?.failure?.kind).toBe("unreachable");
    await vi.advanceTimersByTimeAsync(1000); // attempt 2: ok
    expect(status(s)).toBe("connected");
    expect(s.store.getState().prompt).toBeNull();
    expect(s.probe).toHaveBeenCalledTimes(2);
  });

  it("an unattended reconnect refuses a changed key instead of prompting", async () => {
    const s = setup({ pinned: "SHA256:aaaa" });
    await s.store.getState().connect("h1");
    s.present("SHA256:evil");
    s.connections[0]?.lose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(s)).toBe("failed");
    expect(s.store.getState().hosts.h1?.failure?.kind).toBe("host-key-mismatch");
    expect(s.store.getState().prompt).toBeNull();
  });

  it("reportFailure starts reconnecting only when the connection is gone", async () => {
    const s = setup({ pinned: "SHA256:aaaa" });
    await s.store.getState().connect("h1");
    s.store.getState().reportFailure("h1", new HostError("command-failed", "exit 1"));
    expect(status(s)).toBe("connected");
    const connection = s.connections[0];
    if (connection) connection.connected = false;
    s.store.getState().reportFailure("h1", new HostError("command-failed", "exit 1"));
    expect(status(s)).toBe("reconnecting");
  });

  it("checkAll retries a pending reconnect immediately (app returned to the foreground)", async () => {
    const s = setup({ pinned: "SHA256:aaaa" });
    await s.store.getState().connect("h1");
    s.connections[0]?.lose();
    s.store.getState().checkAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(status(s)).toBe("connected");
  });

  it("disconnect cancels reconnects and closes the connection", async () => {
    const s = setup({ pinned: "SHA256:aaaa" });
    await s.store.getState().connect("h1");
    s.store.getState().disconnect("h1");
    expect(status(s)).toBe("idle");
    expect(s.connections[0]?.closed).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.probe).toHaveBeenCalledTimes(1);
  });

  it("ensureConnected shares one connect and does not retry a failure", async () => {
    const s = setup({
      pinned: "SHA256:aaaa",
      steps: [new SshError(SSH_ERROR_CODES.TIMEOUT, "slow")],
    });
    const a = s.store.getState().ensureConnected("h1");
    const b = s.store.getState().ensureConnected("h1");
    expect(a).toBe(b);
    expect(await a).toBeNull();
    expect(s.store.getState().hosts.h1?.failure?.kind).toBe("timeout");
    expect(await s.store.getState().ensureConnected("h1")).toBeNull();
    expect(s.connections).toHaveLength(0);
  });
});
