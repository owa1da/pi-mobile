import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SSH_ERROR_CODES, isSshError } from "./errors";
import { createNodeSshClient } from "./node-client";
import { startIsolatedSshd, type IsolatedSshd } from "./test-support/isolated-sshd";
import type { SshConnection, SshHostKey } from "./types";

const client = createNodeSshClient();
let sshd: IsolatedSshd;

function keyTarget(privateKey = sshd.privateKey) {
  return {
    host: sshd.host,
    port: sshd.port,
    username: sshd.username,
    auth: { type: "key" as const, privateKey },
  };
}

async function connect(): Promise<{ conn: SshConnection; seen: SshHostKey[] }> {
  const seen: SshHostKey[] = [];
  const conn = await client.connect(keyTarget(), {
    verifyHostKey: async (key) => {
      seen.push(key);
      return key.fingerprint === sshd.hostFingerprint;
    },
  });
  return { conn, seen };
}

beforeAll(async () => {
  sshd = await startIsolatedSshd();
});

afterAll(async () => {
  await sshd?.stop();
});

describe("node ssh client against isolated sshd", () => {
  it("reports the host key fingerprint in ssh-keygen format and authenticates with an ed25519 key", async () => {
    const { conn, seen } = await connect();
    expect(seen).toEqual([{ algorithm: "ssh-ed25519", fingerprint: sshd.hostFingerprint }]);
    expect(sshd.hostFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(conn.isConnected()).toBe(true);
    conn.close();
    expect(conn.isConnected()).toBe(false);
  });

  it("rejecting the host key fails the connect without attempting authentication", async () => {
    const before = sshd.logs();
    const error = await client.connect(keyTarget(), { verifyHostKey: async () => false }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isSshError(error, SSH_ERROR_CODES.HOST_KEY_REJECTED)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const added = sshd.logs().slice(before.length);
    expect(added).not.toMatch(/Accepted publickey|Failed publickey|Postponed publickey/);
  });

  it("fails with AUTH_FAILED for an unauthorized key", async () => {
    const other = await client.generateKeyPair("unauthorized");
    const error = await client
      .connect(keyTarget(other.privateKey), { verifyHostKey: async () => true })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isSshError(error, SSH_ERROR_CODES.AUTH_FAILED)).toBe(true);
  });

  it("fails with AUTH_FAILED for a password when the server only allows keys", async () => {
    const error = await client
      .connect(
        { ...keyTarget(), auth: { type: "password", password: "nope" } },
        { verifyHostKey: async () => true },
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isSshError(error, SSH_ERROR_CODES.AUTH_FAILED)).toBe(true);
  });

  it("exec returns stdout, stderr and exit code, passes stdin, and handles UTF-8", async () => {
    const { conn } = await connect();
    try {
      const result = await conn.exec("printf 'out-ü'; printf 'err-€' >&2; exit 7");
      expect(result).toEqual({ stdout: "out-ü", stderr: "err-€", exitCode: 7 });

      const echoed = await conn.exec("cat; echo done", { stdin: "héllo\nwörld\n" });
      expect(echoed).toEqual({ stdout: "héllo\nwörld\ndone\n", stderr: "", exitCode: 0 });

      const ok = await conn.exec("true");
      expect(ok.exitCode).toBe(0);
    } finally {
      conn.close();
    }
  });

  it("exec handles multi-megabyte output", async () => {
    const { conn } = await connect();
    try {
      // 4 MiB of 'a' followed by a marker.
      const result = await conn.exec("head -c 4194304 /dev/zero | tr '\\0' a; echo END");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(4 * 1024 * 1024 + 4);
      expect(result.stdout.endsWith("aEND\n")).toBe(true);
    } finally {
      conn.close();
    }
  });

  it("exec timeout rejects with TIMEOUT", async () => {
    const { conn } = await connect();
    try {
      const error = await conn.exec("sleep 5", { timeoutMs: 300 }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isSshError(error, SSH_ERROR_CODES.TIMEOUT)).toBe(true);
    } finally {
      conn.close();
    }
  });

  it("generateKeyPair output is a valid OpenSSH key that ssh-keygen and sshd accept", async () => {
    const pair = await client.generateKeyPair("pi-mobile test");
    expect(pair.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    expect(pair.publicKey).toMatch(/^ssh-ed25519 AAAA[A-Za-z0-9+/=]+ pi-mobile test$/);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-keygen-"));
    try {
      const keyPath = path.join(tmp, "id");
      fs.writeFileSync(keyPath, pair.privateKey, { mode: 0o600 });
      const derived = execFileSync("ssh-keygen", ["-y", "-f", keyPath], {
        encoding: "utf8",
      }).trim();
      expect(derived.split(" ").slice(0, 2)).toEqual(pair.publicKey.split(" ").slice(0, 2));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    sshd.authorizeKey(pair.publicKey);
    const conn = await client.connect(keyTarget(pair.privateKey), {
      verifyHostKey: async (key) => key.fingerprint === sshd.hostFingerprint,
    });
    expect((await conn.exec("echo ok")).stdout).toBe("ok\n");
    conn.close();
  });

  it("notifies onClose with an error when the server goes away", async () => {
    const local = await startIsolatedSshd();
    try {
      const conn = await client.connect(
        {
          host: local.host,
          port: local.port,
          username: local.username,
          auth: { type: "key", privateKey: local.privateKey },
        },
        { verifyHostKey: async () => true },
      );
      const connClosed = new Promise<Error | undefined>((resolve) => conn.onClose(resolve));
      // Kill the session processes for this sshd only (children of its listener).
      execFileSync("pkill", [
        "-TERM",
        "-f",
        `sshd-session.*${local.username}`,
        "-P",
        String(readPid(local)),
      ]);
      await local.stop();
      await connClosed;
      expect(conn.isConnected()).toBe(false);
    } finally {
      await local.stop();
    }
  });
});

function readPid(server: IsolatedSshd): number {
  return Number(fs.readFileSync(path.join(server.dir, "sshd.pid"), "utf8").trim());
}
