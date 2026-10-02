import { describe, expect, it, vi } from "vitest";
import type {
  PiSshConnectOptions,
  PiSshEventMap,
  PiSshNativeModule,
} from "../../modules/pi-ssh/src/PiSsh.types";
import { SSH_ERROR_CODES, isSshError } from "./errors";
import { createNativeSshClient } from "./native-client";
import type { SshTarget } from "./types";

type Listener = (event: never) => void;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeNative implements PiSshNativeModule {
  listeners = new Map<string, Set<Listener>>();
  connectCalls: PiSshConnectOptions[] = [];
  hostKeyResponses: { requestId: string; accept: boolean }[] = [];
  disconnected: string[] = [];
  connected = new Set<string>();
  /** Behaviour of connect: emit a host key event then resolve/reject based on the response. */
  hostKey = { algorithm: "ssh-ed25519", fingerprint: "SHA256:abc" };
  skipHostKey = false;
  connectError: (Error & { code?: string }) | null = null;
  execImpl = vi.fn(async (_c: string, _cmd: string, _stdin: string | null, _t: number | null) => ({
    stdout: "out",
    stderr: "",
    exitCode: 0 as number | null,
  }));

  private pendingHostKey = new Map<string, (accept: boolean) => void>();

  async connect(options: PiSshConnectOptions): Promise<string> {
    this.connectCalls.push(options);
    if (this.connectError) throw this.connectError;
    if (!this.skipHostKey) {
      const requestId = `req-${options.connectionId}`;
      const accepted = await new Promise<boolean>((resolve) => {
        this.pendingHostKey.set(requestId, resolve);
        this.emit("onHostKey", { connectionId: options.connectionId, requestId, ...this.hostKey });
      });
      if (!accepted) {
        throw Object.assign(new Error("Host key rejected; not authenticating"), {
          code: SSH_ERROR_CODES.HOST_KEY_REJECTED,
        });
      }
    }
    this.connected.add(options.connectionId);
    return options.connectionId;
  }

  respondHostKey(requestId: string, accept: boolean): boolean {
    this.hostKeyResponses.push({ requestId, accept });
    const resolve = this.pendingHostKey.get(requestId);
    this.pendingHostKey.delete(requestId);
    resolve?.(accept);
    return resolve !== undefined;
  }

  exec(connectionId: string, command: string, stdin: string | null, timeoutMs: number | null) {
    return this.execImpl(connectionId, command, stdin, timeoutMs);
  }

  isConnected(connectionId: string): boolean {
    return this.connected.has(connectionId);
  }
  disconnect(connectionId: string): void {
    this.disconnected.push(connectionId);
    this.connected.delete(connectionId);
  }
  async generateKeyPair(comment: string) {
    return {
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\n",
      publicKey: `ssh-ed25519 AAAA ${comment}`,
    };
  }

  addListener<K extends keyof PiSshEventMap>(
    eventName: K,
    listener: (event: PiSshEventMap[K]) => void,
  ) {
    let set = this.listeners.get(eventName);
    if (!set) {
      set = new Set();
      this.listeners.set(eventName, set);
    }
    set.add(listener as Listener);
    return { remove: () => set.delete(listener as Listener) };
  }

  emit<K extends keyof PiSshEventMap>(eventName: K, event: PiSshEventMap[K]): void {
    for (const listener of Array.from(this.listeners.get(eventName) ?? [])) {
      (listener as (e: PiSshEventMap[K]) => void)(event);
    }
  }

  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

const target: SshTarget = {
  host: "example.test",
  port: 2222,
  username: "pi",
  auth: { type: "key", privateKey: "PRIVATE", passphrase: "pw" },
};

function setup() {
  const native = new FakeNative();
  let n = 0;
  const client = createNativeSshClient(native, { createId: (prefix) => `${prefix}${++n}` });
  return { native, client };
}

describe("native ssh client", () => {
  it("passes target and options to native connect and asks verifyHostKey once", async () => {
    const { native, client } = setup();
    const verifyHostKey = vi.fn(async () => true);
    const conn = await client.connect(target, { verifyHostKey, timeoutMs: 5000 });
    expect(verifyHostKey).toHaveBeenCalledTimes(1);
    expect(verifyHostKey).toHaveBeenCalledWith({
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:abc",
    });
    expect(native.connectCalls[0]).toMatchObject({
      connectionId: "c1",
      host: "example.test",
      port: 2222,
      username: "pi",
      privateKey: "PRIVATE",
      passphrase: "pw",
      timeoutMs: 5000,
    });
    expect(native.connectCalls[0]).not.toHaveProperty("password");
    expect(native.hostKeyResponses).toEqual([{ requestId: "req-c1", accept: true }]);
    expect(conn.isConnected()).toBe(true);
  });

  it("sends a password auth without key fields", async () => {
    const { native, client } = setup();
    await client.connect(
      { ...target, auth: { type: "password", password: "secret" } },
      { verifyHostKey: async () => true },
    );
    expect(native.connectCalls[0].password).toBe("secret");
    expect(native.connectCalls[0]).not.toHaveProperty("privateKey");
  });

  it("rejecting the host key fails connect with HOST_KEY_REJECTED and cleans up listeners", async () => {
    const { native, client } = setup();
    const error = await client.connect(target, { verifyHostKey: async () => false }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isSshError(error, SSH_ERROR_CODES.HOST_KEY_REJECTED)).toBe(true);
    expect(native.hostKeyResponses).toEqual([{ requestId: "req-c1", accept: false }]);
    expect(native.listenerCount()).toBe(0);
  });

  it("a throwing or rejecting verifyHostKey is treated as reject", async () => {
    const { native, client } = setup();
    const e1 = await client
      .connect(target, {
        verifyHostKey: () => {
          throw new Error("boom");
        },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    const e2 = await client
      .connect(target, { verifyHostKey: () => Promise.reject(new Error("no")) })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isSshError(e1, SSH_ERROR_CODES.HOST_KEY_REJECTED)).toBe(true);
    expect(isSshError(e2, SSH_ERROR_CODES.HOST_KEY_REJECTED)).toBe(true);
    expect(native.hostKeyResponses.map((r) => r.accept)).toEqual([false, false]);
  });

  it("refuses a connection that native completed without a host key decision", async () => {
    const { native, client } = setup();
    native.skipHostKey = true;
    const error = await client.connect(target, { verifyHostKey: async () => true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isSshError(error, SSH_ERROR_CODES.HOST_KEY_REJECTED)).toBe(true);
    expect(native.disconnected).toEqual(["c1"]);
  });

  it("maps native error codes and keeps unknown failures as CONNECT_FAILED", async () => {
    const { native, client } = setup();
    native.connectError = Object.assign(new Error("Authentication failed"), {
      code: SSH_ERROR_CODES.AUTH_FAILED,
    });
    const e1 = await client
      .connect(target, { verifyHostKey: async () => true })
      .catch((e: unknown) => e);
    expect(isSshError(e1, SSH_ERROR_CODES.AUTH_FAILED)).toBe(true);
    native.connectError = Object.assign(new Error("weird"), { code: "E_SOMETHING" });
    const e2 = await client
      .connect(target, { verifyHostKey: async () => true })
      .catch((e: unknown) => e);
    expect(isSshError(e2, SSH_ERROR_CODES.CONNECT_FAILED)).toBe(true);
    expect((e2 as Error).message).toBe("weird");
  });

  it("ignores host key events for unknown connections by rejecting them", async () => {
    const { native, client } = setup();
    await client.connect(target, { verifyHostKey: async () => true });
    native.emit("onHostKey", {
      connectionId: "nope",
      requestId: "r-x",
      algorithm: "a",
      fingerprint: "f",
    });
    expect(native.hostKeyResponses.at(-1)).toEqual({ requestId: "r-x", accept: false });
  });

  it("exec forwards stdin/timeout and normalizes a missing exit code to null", async () => {
    const { native, client } = setup();
    const conn = await client.connect(target, { verifyHostKey: async () => true });
    native.execImpl.mockResolvedValueOnce({
      stdout: "a",
      stderr: "b",
      exitCode: undefined as unknown as null,
    });
    const result = await conn.exec("cmd", { stdin: "in", timeoutMs: 100 });
    expect(native.execImpl).toHaveBeenCalledWith("c1", "cmd", "in", 100);
    expect(result).toEqual({ stdout: "a", stderr: "b", exitCode: null });
    await conn.exec("cmd2");
    expect(native.execImpl).toHaveBeenLastCalledWith("c1", "cmd2", null, null);
    native.execImpl.mockRejectedValueOnce(
      Object.assign(new Error("t"), { code: SSH_ERROR_CODES.TIMEOUT }),
    );
    const error = await conn.exec("slow").catch((e: unknown) => e);
    expect(isSshError(error, SSH_ERROR_CODES.TIMEOUT)).toBe(true);
  });

  it("connection loss notifies onClose with an error, then unsubscribes", async () => {
    const { native, client } = setup();
    const conn = await client.connect(target, { verifyHostKey: async () => true });
    const order: string[] = [];
    conn.onClose((error) => order.push(`conn:${(error as { code?: string } | undefined)?.code}`));
    native.connected.delete("c1");
    native.emit("onConnectionClose", { connectionId: "c1", reason: "lost" });
    expect(order).toEqual([`conn:${SSH_ERROR_CODES.CONNECTION_CLOSED}`]);
    expect(conn.isConnected()).toBe(false);
    expect(native.listenerCount()).toBe(0);
    const error = await conn.exec("x").catch((e: unknown) => e);
    expect(isSshError(error, SSH_ERROR_CODES.NOT_CONNECTED)).toBe(true);
  });

  it("close() disconnects natively, notifies without error once, and late onClose still fires", async () => {
    const { native, client } = setup();
    const conn = await client.connect(target, { verifyHostKey: async () => true });
    const calls: (Error | undefined)[] = [];
    conn.onClose((error) => calls.push(error));
    conn.close();
    conn.close();
    native.emit("onConnectionClose", { connectionId: "c1", reason: "closed" });
    expect(native.disconnected).toEqual(["c1"]);
    expect(calls).toEqual([undefined]);
    const late = vi.fn();
    conn.onClose(late);
    await flush();
    expect(late).toHaveBeenCalledTimes(1);
    expect(native.listenerCount()).toBe(0);
  });

  it("keeps subscriptions while another connection is open", async () => {
    const { native, client } = setup();
    const a = await client.connect(target, { verifyHostKey: async () => true });
    const b = await client.connect(target, { verifyHostKey: async () => true });
    a.close();
    expect(native.listenerCount()).toBe(2);
    b.close();
    expect(native.listenerCount()).toBe(0);
  });

  it("generateKeyPair passes through and maps errors", async () => {
    const { native, client } = setup();
    expect(await client.generateKeyPair("me@phone")).toEqual({
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\n",
      publicKey: "ssh-ed25519 AAAA me@phone",
    });
    native.generateKeyPair = async () => {
      throw new Error("nope");
    };
    const error = await client.generateKeyPair("x").catch((e: unknown) => e);
    expect(isSshError(error, SSH_ERROR_CODES.KEYGEN_FAILED)).toBe(true);
  });
});
