// HostService over real SSH: an isolated unprivileged sshd (src/ssh/test-support/isolated-sshd.ts)
// and the ssh2 test client (src/ssh/node-client.ts). sshd runs commands in the real user's login
// shell, so this test only reads the sandbox registry and pastes into a fake pi on the sandbox's
// private tmux server (agentDir/tmuxSocket overrides); it never starts or resumes anything.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNodeSshClient } from "@/ssh/node-client";
import { startIsolatedSshd, type IsolatedSshd } from "@/ssh/test-support/isolated-sshd";
import type { SshConnection } from "@/ssh/types";

import { createHostService, type PiHostService } from "./service";
import { createSandbox, type Sandbox } from "./test-support/sandbox";
import type { SessionRow } from "./types";

const hasSshd = fs.existsSync("/usr/sbin/sshd");
// A missing sshd must not pass silently: it is skipped only when explicitly allowed.
const allowNoSshd = process.env.PIM_ALLOW_NO_SSHD === "1";

describe("sshd for the SSH integration test", () => {
  it.skipIf(allowNoSshd)("is installed (set PIM_ALLOW_NO_SSHD=1 to skip the SSH test)", () => {
    expect(hasSshd, "/usr/sbin/sshd is missing; set PIM_ALLOW_NO_SSHD=1 to skip").toBe(true);
  });
});

describe.skipIf(!hasSshd)("host service over real SSH", () => {
  let sshd: IsolatedSshd;
  let conn: SshConnection;
  let sb: Sandbox;
  let local: PiHostService;
  let remote: PiHostService;

  beforeAll(async () => {
    sb = createSandbox();
    local = sb.service();
    sshd = await startIsolatedSshd();
    conn = await createNodeSshClient().connect(
      {
        host: sshd.host,
        port: sshd.port,
        username: sshd.username,
        auth: { type: "key", privateKey: sshd.privateKey },
      },
      { verifyHostKey: async (key) => key.fingerprint === sshd.hostFingerprint },
    );
    remote = createHostService(conn, {
      agentDir: sb.agentDir,
      tmuxSocket: sb.socket,
      useLoginShell: true,
    });
  });

  afterAll(async () => {
    conn?.close();
    await sshd?.stop();
    sb?.cleanup();
  });

  it("probes, lists, reads chat and sends a prompt over SSH", async () => {
    const env = await remote.probe();
    expect(env.agentDir).toBe(sb.agentDir);
    expect(env.tmuxSocket).toBe(sb.socket);
    expect(env.tmuxPath).toMatch(/tmux$/);

    // The fake pi is started locally on the sandbox's tmux server.
    const started = await local.startSession({ prompt: "over ssh", cwd: sb.home });
    let row: SessionRow | undefined;
    const deadline = Date.now() + 10_000;
    while (!row) {
      row = (await remote.listSessions()).rows.find(
        (r) => r.pid === started.pid && r.messages >= 2 && r.state === "idle",
      );
      if (!row && Date.now() > deadline) throw new Error("no row over ssh");
      if (!row) await new Promise((r) => setTimeout(r, 100));
    }
    expect(row.tmux).toEqual({ socket: sb.socket, pane: started.pane });

    const chat = await remote.readChat(row);
    expect(chat.items.map((i) => i.kind)).toEqual(["user", "assistant"]);

    const text = `via ssh: 'q' "dq" $HOME \`id\`\nsecond line ✓`;
    await remote.sendPrompt(row, text);
    const submit = await sb.waitForEvent(
      started.pid,
      (e) => e.kind === "submit" && e.text === text,
      5000,
      "ssh submit",
    );
    expect(submit.pasted).toBe(true);

    // Terminal attach through an SSH pty.
    const att = remote.terminalFor(row);
    const shell = await conn.openShell({ cols: 70, rows: 20, command: att.command });
    await sb.waitFor(
      () =>
        sb.tmux("list-clients", "-F", "#{client_session} #{client_flags}").includes("ignore-size"),
      10_000,
      "ssh client",
    );
    shell.close();
    const res = await conn.exec(att.cleanupCommand);
    expect(res.exitCode).toBe(0);
    await sb.waitFor(
      () => !sb.tmux("list-sessions", "-F", "#{session_name}").includes("pim-"),
      5000,
      "cleanup",
    );
  });
});
