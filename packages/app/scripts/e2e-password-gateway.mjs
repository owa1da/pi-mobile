// Password sign-in for the emulator journey. An unprivileged sshd cannot check passwords (that
// needs root to read /etc/shadow), so this is a small ssh2 server on its own loopback port that
// accepts exactly one test user + password and runs exec/shell requests as the current user with
// the same sandbox environment the isolated sshd sets (HOME=<sandbox home>, SHELL=/bin/sh). The
// app's native client (jsch) authenticates against it over the real SSH protocol.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";

const { Server } = ssh2;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sandboxEnv(home, extra = {}) {
  return {
    HOME: home,
    SHELL: "/bin/sh",
    USER: process.env.USER ?? "",
    LOGNAME: process.env.USER ?? "",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    ...extra,
  };
}

function wire(stream, child) {
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream.stderr, { end: false });
  stream.pipe(child.stdin);
  child.on("close", (code, signal) => {
    if (signal) stream.exit(signal.replace(/^SIG/, ""), false, "");
    else stream.exit(code ?? 0);
    stream.end();
  });
  stream.on("close", () => child.kill("SIGHUP"));
}

/**
 * Starts the gateway. Returns { port, close, authLog } where authLog collects
 * `{ method, ok }` entries for every authentication attempt (also appended to `logFile`).
 */
export async function startPasswordGateway({
  hostKeyPath,
  home,
  username,
  password,
  port,
  logFile,
}) {
  const authLog = [];
  const server = new Server({ hostKeys: [fs.readFileSync(hostKeyPath)] }, (client) => {
    client.on("authentication", (ctx) => {
      const ok =
        ctx.method === "password" &&
        safeEqual(ctx.username, username) &&
        safeEqual(ctx.password, password);
      const entry = { method: ctx.method, user: ctx.username, ok };
      authLog.push(entry);
      if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
      if (ok) ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        let pty = null;
        session.on("pty", (accept, _reject, info) => {
          pty = info;
          accept?.();
        });
        session.on("window-change", (accept) => accept?.());
        session.on("env", (accept) => accept?.());
        session.on("exec", (accept, _reject, info) => {
          const stream = accept();
          const child = spawn("/bin/sh", ["-c", info.command], {
            cwd: home,
            env: sandboxEnv(home),
          });
          wire(stream, child);
        });
        session.on("shell", (accept) => {
          // The journey's password host only lists sessions; a pty shell is a plain login shell.
          const stream = accept();
          const env = sandboxEnv(home, pty ? { TERM: pty.term || "xterm-256color" } : {});
          const child = spawn("/bin/sh", ["-l"], { cwd: home, env });
          wire(stream, child);
        });
      });
    });
    client.on("error", () => undefined);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port,
    authLog,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// CLI (spawned detached by the journey so adb's synchronous calls never stall the server):
// PIM_GW_HOST_KEY PIM_GW_HOME PIM_GW_USER PIM_GW_PASSWORD PIM_GW_PORT PIM_GW_LOG
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  await startPasswordGateway({
    hostKeyPath: env.PIM_GW_HOST_KEY,
    home: env.PIM_GW_HOME,
    username: env.PIM_GW_USER,
    password: env.PIM_GW_PASSWORD,
    port: Number(env.PIM_GW_PORT),
    logFile: env.PIM_GW_LOG,
  });
  console.log(`password gateway listening on 127.0.0.1:${env.PIM_GW_PORT}`);
}
