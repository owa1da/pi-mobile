// Starts a throwaway, unprivileged OpenSSH server for tests. Everything lives in a temp dir: host
// key, client key, authorized_keys, config and pid file. It never reads or writes ~/.ssh,
// /etc/ssh/sshd_config or the system sshd on port 22. Only the current OS user can log in
// (a non-root sshd can only authenticate as the user running it).
//
// Node-only (uses child_process/fs). Usable from vitest or directly with
// `node --experimental-strip-types` (no non-erasable TS syntax here).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface IsolatedSshd {
  host: string;
  port: number;
  username: string;
  /** OpenSSH PEM ed25519 private key authorized for `username`. */
  privateKey: string;
  /** Matching "ssh-ed25519 AAAA... comment" line. */
  publicKey: string;
  /** "SHA256:..." of the server's ed25519 host key, as printed by `ssh-keygen -lf`. */
  hostFingerprint: string;
  hostKeyAlgorithm: "ssh-ed25519";
  /** Temp dir holding config/keys; removed by stop(). */
  dir: string;
  authorizedKeysPath: string;
  /** Appends a public key line to this server's authorized_keys (never the user's). */
  authorizeKey(publicKeyLine: string): void;
  /** Recent sshd stderr (logged with -e), useful in assertion messages. */
  logs(): string;
  stop(): Promise<void>;
}

export interface IsolatedSshdOptions {
  /** Addresses to listen on. Default ["127.0.0.1"]. Add "0.0.0.0" only if you really need it. */
  listenAddresses?: string[];
  /** Fixed port; default picks a free one. */
  port?: number;
  /** Extra sshd_config lines appended verbatim. */
  extraConfig?: string[];
  /** Path to sshd. Default /usr/sbin/sshd. */
  sshdPath?: string;
  startTimeoutMs?: number;
}

function sshKeygen(args: string[]): string {
  return execFileSync("ssh-keygen", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function currentUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? "root";
  }
}

export async function startIsolatedSshd(options: IsolatedSshdOptions = {}): Promise<IsolatedSshd> {
  const sshdPath = options.sshdPath ?? "/usr/sbin/sshd";
  const listen = options.listenAddresses ?? ["127.0.0.1"];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-isolated-sshd-"));
  const hostKeyPath = path.join(dir, "ssh_host_ed25519_key");
  const clientKeyPath = path.join(dir, "client_ed25519");
  const authorizedKeysPath = path.join(dir, "authorized_keys");
  const configPath = path.join(dir, "sshd_config");
  const pidPath = path.join(dir, "sshd.pid");

  let child: ChildProcess | null = null;
  try {
    sshKeygen(["-q", "-t", "ed25519", "-N", "", "-C", "isolated-sshd-host", "-f", hostKeyPath]);
    sshKeygen(["-q", "-t", "ed25519", "-N", "", "-C", "isolated-sshd-client", "-f", clientKeyPath]);
    const privateKey = fs.readFileSync(clientKeyPath, "utf8");
    const publicKey = fs.readFileSync(`${clientKeyPath}.pub`, "utf8").trim();
    fs.writeFileSync(authorizedKeysPath, publicKey + "\n", { mode: 0o600 });
    // "256 SHA256:xxxx comment (ED25519)"
    const hostFingerprint = sshKeygen(["-lf", `${hostKeyPath}.pub`])
      .trim()
      .split(/\s+/)[1];

    const port =
      options.port ?? (await freePort(listen[0] === "0.0.0.0" ? "127.0.0.1" : listen[0]));
    const config = [
      `Port ${port}`,
      ...listen.map((address) => `ListenAddress ${address}`),
      `HostKey ${hostKeyPath}`,
      `PidFile ${pidPath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      "StrictModes no",
      "UsePAM no",
      "PubkeyAuthentication yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PermitRootLogin no",
      // OpenSSH >= 9.8 penalizes sources after failed auths; tests deliberately fail auth.
      "PerSourcePenalties no",
      "MaxStartups 100",
      "MaxAuthTries 10",
      "PermitUserEnvironment no",
      "PermitUserRC no",
      "PrintMotd no",
      "PrintLastLog no",
      "X11Forwarding no",
      "AllowAgentForwarding no",
      "AcceptEnv LANG LC_*",
      "LogLevel INFO",
      ...(options.extraConfig ?? []),
      "",
    ].join("\n");
    fs.writeFileSync(configPath, config);

    let log = "";
    const proc = spawn(sshdPath, ["-D", "-e", "-f", configPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child = proc;
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      log = (log + chunk).slice(-64 * 1024);
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => settle(new Error(`isolated sshd did not start within timeout:\n${log}`)),
        options.startTimeoutMs ?? 10_000,
      );
      proc.stderr?.on("data", () => {
        if (/Server listening on/.test(log)) settle();
      });
      proc.on("exit", (code, signal) => {
        settle(new Error(`isolated sshd exited early (code ${code}, signal ${signal}):\n${log}`));
      });
      proc.on("error", (error) => settle(error));
    });
    proc.removeAllListeners("exit");

    let stopped = false;
    return {
      host: listen.includes("127.0.0.1") || listen.includes("0.0.0.0") ? "127.0.0.1" : listen[0],
      port,
      username: currentUser(),
      privateKey,
      publicKey,
      hostFingerprint,
      hostKeyAlgorithm: "ssh-ed25519",
      dir,
      authorizedKeysPath,
      authorizeKey(publicKeyLine: string): void {
        fs.appendFileSync(authorizedKeysPath, publicKeyLine.trim() + "\n");
      },
      logs: () => log,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        if (proc.exitCode === null && proc.signalCode === null) {
          const exited = once(proc, "exit");
          const killTimer = setTimeout(() => proc.kill("SIGKILL"), 3_000);
          proc.kill("SIGTERM");
          await exited;
          clearTimeout(killTimer);
        }
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
