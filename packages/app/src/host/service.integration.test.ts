// HostService end to end on this machine: LocalConnection (sh -c), a private tmux server
// (`-S <tmp>/tmux/sock`), a temp agent dir and a fake pi (test-support/fake-pi.mjs).
// Never touches the user's tmux server or ~/.pi.

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SSH_ERROR_CODES, SshError } from "@/ssh/errors";
import type { SshConnection } from "@/ssh/types";

import { makeNonce, startScript, wrapForAnyShell } from "./commands";
import { HostOutcomeUnknownError, PaneBusyError } from "./errors";
import { createSandbox, FAKE_PI, type FakeEvent, type Sandbox } from "./test-support/sandbox";
import { createHostService, type PiHostService } from "./service";
import { HostError, type SessionRow } from "./types";

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

async function rowFor(
  sb: Sandbox,
  svc: PiHostService,
  pred: (r: SessionRow) => boolean,
  label: string,
): Promise<SessionRow> {
  let found: SessionRow | undefined;
  void sb;
  const deadline = Date.now() + 10_000;
  while (!found) {
    const snap = await svc.listSessions();
    found = snap.rows.find(pred);
    if (found) break;
    if (Date.now() > deadline)
      throw new Error(`no row: ${label}\n${JSON.stringify(snap.rows, null, 1)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return found;
}

/** The texts the fake pi `pid` submitted, in order. */
function submitTexts(sb: Sandbox, pid: number): Array<string | undefined> {
  return sb
    .events(pid)
    .filter((e) => e.kind === "submit")
    .map((e) => e.text);
}

async function expectHostError(p: Promise<unknown>, code: HostError["code"]): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof HostError && e.code === code);
}

describe("probe errors", () => {
  it("reports pi-missing, tmux-missing and forge-missing", async () => {
    const noPi = createSandbox({ withPi: false });
    const noTmux = createSandbox({ withTmux: false });
    const noForge = createSandbox({ withForge: false });
    try {
      await expectHostError(noPi.service().probe(), "pi-missing");
      await expectHostError(noTmux.service().probe(), "tmux-missing");
      await expectHostError(noForge.service().probe(), "forge-missing");
    } finally {
      noPi.cleanup();
      noTmux.cleanup();
      noForge.cleanup();
    }
  });
});

describe("host service on an isolated tmux server", () => {
  let sb: Sandbox;
  let svc: PiHostService;

  beforeAll(() => {
    sb = createSandbox();
    svc = sb.service();
  });
  afterAll(() => sb?.cleanup());

  it("probes node, pi, tmux, socket and agent dir (login shell too)", async () => {
    const env = await svc.probe();
    expect(env.piKind).toBe("node");
    expect(env.nodePath).toBe(fs.realpathSync(process.execPath));
    expect(env.piCliPath).toMatch(/fake-pi\.mjs$/);
    expect(env.tmuxPath).toMatch(/tmux$/);
    expect(env.tmuxSocket).toBe(sb.socket);
    expect(env.agentDir).toBe(sb.agentDir);
    expect(env.forwardEnv).toContain(`PI_CODING_AGENT_DIR=${sb.agentDir}`);
    const login = await sb.service({ useLoginShell: true, tmuxSocket: undefined }).probe();
    expect(login.piCliPath).toBe(env.piCliPath);
    // No live records yet: tmux's default socket under TMUX_TMPDIR.
    expect(login.tmuxSocket).toBe(
      path.join(sb.dir, "tmux", `tmux-${process.getuid!()}`, "default"),
    );
  });

  it("starts a session with no tmux server, then adds windows to it", async () => {
    const prompt = `it's "$HOME" \`id\` a;b #{pane_id} end;`;
    const started = await svc.startSession({
      prompt,
      cwd: sb.home,
      model: "prov/model-x",
      thinking: "high",
    });
    expect(started.tmuxSession).toBe("pi");
    expect(started.pane).toMatch(/^%\d+$/);
    expect(started.windowId).toMatch(/^@\d+$/);
    const start = await sb.waitForEvent(
      started.pid,
      (e) => e.kind === "start",
      10_000,
      "fake pi start",
    );
    expect(start.argv).toEqual(["--model", "prov/model-x", "--thinking", "high", "--", prompt]);
    expect(start.cwd).toBe(sb.home);
    expect(start.pane).toBe(started.pane);
    expect(start.agentEnv).toBe(sb.agentDir);
    const submitted = await sb.waitForEvent(
      started.pid,
      (e) => e.kind === "submit",
      5000,
      "submit",
    );
    expect(submitted.text).toBe(prompt);

    const row = await rowFor(
      sb,
      svc,
      (r) => r.live && r.pid === started.pid && r.messages >= 2,
      "started row",
    );
    expect(row.tmux).toEqual({ socket: sb.socket, pane: started.pane });
    expect(row.model).toMatchObject({ provider: "prov", id: "model-x", thinking: "high" });
    expect(row.section).toBe("completed");
    // forge's title(): markdown spans (backticks) stripped.
    expect(row.title).toBe(`it's "$HOME" id a;b #{pane_id} end;`);

    const second = await svc.startSession({ prompt: "@file.ts what is this", cwd: sb.home });
    expect(second.tmuxSession).toBe("pi");
    expect(second.windowId).not.toBe(started.windowId);
    const start2 = await sb.waitForEvent(
      second.pid,
      (e) => e.kind === "start",
      10_000,
      "second start",
    );
    // forge: a prompt starting with @ gets a leading space; no --model/--thinking when not given.
    expect(start2.argv).toEqual(["--", " @file.ts what is this"]);
    expect(sb.tmux("list-windows", "-t", "pi", "-F", "#{window_name}").trim().split("\n")).toEqual(
      expect.arrayContaining(["its-HOME-id", "file.ts-what-is"]),
    );
  });

  it("rejects a missing cwd", async () => {
    await expectHostError(
      svc.startSession({ prompt: "x", cwd: path.join(sb.dir, "nope") }),
      "not-found",
    );
  });

  it("sends a hostile multi-line prompt by bracketed paste + Enter", async () => {
    const started = await svc.startSession({ cwd: sb.home });
    await sb.waitForEvent(started.pid, (e) => e.kind === "start", 10_000, "start");
    const row = await rowFor(sb, svc, (r) => r.pid === started.pid, "empty session row");
    expect(row.section).toBe("needs"); // never prompted
    expect(row.detail).toBe("send a prompt to start");
    const text = `line 1 'q' "dq" $HOME \`id\` $(id)\nline 2 ; \\ end;\n\tünïcødé ✓ 🎉\n#{pane_id}`;
    await svc.sendPrompt(row, text);
    const submit = await sb.waitForEvent(started.pid, (e) => e.kind === "submit", 5000, "submit");
    expect(submit.text).toBe(text);
    expect(submit.pasted).toBe(true);
    const input = sb
      .events(started.pid)
      .filter((e) => e.kind === "input")
      .map((e) => e.hex)
      .join("");
    expect(input).toBe(`${hex("\x1b[200~")}${hex(text)}${hex("\x1b[201~")}0d`);
  });

  it("refuses while pi shows a dialog, and while the pane is in copy mode", async () => {
    const started = await svc.startSession({ prompt: "hello", cwd: sb.home });
    let row = await rowFor(
      sb,
      svc,
      (r) => r.pid === started.pid && r.state === "idle" && r.messages >= 2,
      "idle row",
    );
    process.kill(started.pid, "SIGUSR2");
    row = await rowFor(
      sb,
      svc,
      (r) => r.pid === started.pid && r.state === "waiting",
      "waiting row",
    );
    expect(row.section).toBe("needs");
    expect(row.asking).toBe("Allow bash?");
    await expectHostError(svc.sendPrompt(row, "nope"), "waiting-for-input");
    // A stale idle row is refused too: the host re-reads the record.
    await expectHostError(svc.sendPrompt({ ...row, state: "idle" }, "nope"), "waiting-for-input");
    process.kill(started.pid, "SIGUSR1");
    row = await rowFor(sb, svc, (r) => r.pid === started.pid && r.state === "idle", "idle again");

    sb.tmux("copy-mode", "-t", started.pane);
    await expectHostError(svc.sendPrompt(row, "nope"), "pane-busy");
    sb.tmux("send-keys", "-t", started.pane, "-X", "cancel");
    await svc.sendPrompt(row, "after copy mode");
    const texts = await sb.waitFor(
      () => {
        const t = submitTexts(sb, started.pid);
        return t.includes("after copy mode") ? t : undefined;
      },
      5000,
      "submit after copy mode",
    );
    expect(texts).not.toContain("nope");
  });

  it("aborts with a single Escape only while working, at most once a second", async () => {
    const started = await svc.startSession({ prompt: "/work", cwd: sb.home });
    const row = await rowFor(
      sb,
      svc,
      (r) => r.pid === started.pid && r.state === "working",
      "working row",
    );
    expect(row.section).toBe("working");
    await Promise.all([svc.abort(row), svc.abort(row)]);
    await svc.abort(row);
    await rowFor(sb, svc, (r) => r.pid === started.pid && r.state === "idle", "idle after abort");
    expect(sb.events(started.pid).filter((e) => e.kind === "escape")).toHaveLength(1);
    // Idle: nothing is sent, even after the rate limit passes.
    await new Promise((r) => setTimeout(r, 1100));
    await svc.abort(row);
    await new Promise((r) => setTimeout(r, 300));
    expect(sb.events(started.pid).filter((e) => e.kind === "escape")).toHaveLength(1);
  });

  it("resumes a closed session and delivers the follow-up there", async () => {
    const started = await svc.startSession({ prompt: "first prompt", cwd: sb.home });
    const live = await rowFor(
      sb,
      svc,
      (r) => r.pid === started.pid && r.messages >= 2 && r.state === "idle",
      "row",
    );
    await expectHostError(svc.resumeSession(live), "session-live");
    await svc.sendPrompt(live, "/quit");
    const closed = await rowFor(
      sb,
      svc,
      (r) => r.sessionId === live.sessionId && !r.live,
      "closed row",
    );
    expect(closed).toMatchObject({
      state: "closed",
      endReason: "quit",
      section: "completed",
      title: "first prompt",
    });

    // A stale live row (forge closed the window): the follow-up still arrives, in a resumed pi.
    await svc.sendPrompt(live, "follow-up\nwith two lines");
    const resumed = await rowFor(
      sb,
      svc,
      (r) => r.sessionId === live.sessionId && r.live && r.messages >= 4,
      "resumed",
    );
    expect(resumed.pid).not.toBe(started.pid);
    const ev = sb.events(resumed.pid!);
    expect(ev.find((e) => e.kind === "start")?.argv).toEqual(["--session", live.sessionFile]);
    expect(ev.find((e) => e.kind === "submit")).toMatchObject({
      text: "follow-up\nwith two lines",
      pasted: true,
    });
    expect(
      sb.tmux("display-message", "-p", "-t", resumed.tmux!.pane, "#{window_name}").trim(),
    ).toBe("pi-resume");

    // resumeSession on a closed row (no prompt).
    await svc.sendPrompt(resumed, "/quit");
    const closed2 = await rowFor(
      sb,
      svc,
      (r) => r.sessionId === live.sessionId && !r.live,
      "closed again",
    );
    const again = await svc.resumeSession(closed2);
    await sb.waitForEvent(again.pid, (e) => e.kind === "start", 10_000, "resume start");
    await rowFor(
      sb,
      svc,
      (r) => r.sessionId === live.sessionId && r.live && r.pid === again.pid,
      "live again",
    );
  });

  it("shows a dead process as a closed 'gone' row", async () => {
    const started = await svc.startSession({ prompt: "doomed", cwd: sb.home });
    await rowFor(sb, svc, (r) => r.pid === started.pid && r.messages >= 2, "row");
    process.kill(started.pid, "SIGKILL");
    const gone = await rowFor(sb, svc, (r) => r.title === "doomed" && !r.live, "gone row");
    expect(gone.endReason).toBe("gone");
    // Read-only: the registry file is left for forge to move.
    expect(fs.existsSync(path.join(sb.procsDir, `${started.pid}.json`))).toBe(true);
  });

  it("starts a prompt over 8 KiB empty, then pastes it once pi is ready", async () => {
    const big = `${"x".repeat(9000)}\nend`;
    const started = await svc.startSession({ prompt: big, cwd: sb.home });
    await sb.waitForEvent(started.pid, (e) => e.kind === "submit", 10_000, "big submit");
    const ev = sb.events(started.pid);
    expect(ev.find((e) => e.kind === "start")?.argv).toEqual([]);
    expect(ev.find((e) => e.kind === "submit")).toMatchObject({ text: big, pasted: true });
    await expectHostError(
      svc.startSession({ prompt: "y".repeat(1024 * 1024 + 1) }),
      "prompt-too-large",
    );
  });

  it("starts and resumes-then-sends when the host shell has no UTF-8 locale (as over SSH)", async () => {
    // Without LANG tmux prints the tabs of -P/-F output as "_"; the start script must not need them.
    const bare = createSandbox();
    try {
      delete bare.env.LANG;
      const plain = bare.service();
      const big = `${"z".repeat(9000)}\nend`;
      const started = await plain.startSession({ prompt: big, cwd: bare.home });
      expect(started.pane).toMatch(/^%\d+$/);
      await bare.waitForEvent(started.pid, (e) => e.kind === "submit", 10_000, "big submit");
      const live = await rowFor(bare, plain, (r) => r.pid === started.pid && r.messages > 0, "row");
      await plain.sendPrompt(live, "/quit");
      const closed = await rowFor(
        bare,
        plain,
        (r) => !r.live && r.sessionId === live.sessionId,
        "closed",
      );
      await plain.sendPrompt(closed, "after resume");
      const resumed = await rowFor(
        bare,
        plain,
        (r) => r.live && r.sessionId === live.sessionId,
        "resumed",
      );
      await bare.waitForEvent(resumed.pid!, (e) => e.kind === "submit", 10_000, "resumed submit");
      expect(submitTexts(bare, resumed.pid!)).toContain("after resume");
    } finally {
      bare.cleanup();
    }
  });

  it("reads the chat of a session incrementally", async () => {
    const started = await svc.startSession({ prompt: "chat one", cwd: sb.home });
    const row = await rowFor(sb, svc, (r) => r.pid === started.pid && r.messages >= 2, "row");
    const first = await svc.readChat(row);
    expect(first.reset).toBe(true);
    expect(first.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    await svc.sendPrompt(row, "chat two");
    await rowFor(sb, svc, (r) => r.pid === started.pid && r.messages >= 4, "4 messages");
    const next = await svc.readChat(row, first.cursor);
    expect(next.reset).toBe(false);
    expect(next.cursor.offset).toBeGreaterThan(first.cursor.offset);
    expect(next.items.map((i) => (i.kind === "user" ? i.text : i.kind))).toEqual([
      "chat one",
      "assistant",
      "chat two",
      "assistant",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Wave 5 fixes: one pi per session, drafts, sanitizing, timeouts, server env, tmux gate, argv.
// ---------------------------------------------------------------------------

function startsOf(sb: Sandbox, sessionId: string): FakeEvent[] {
  const dir = path.join(sb.agentDir, "fake-pi");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .flatMap((f) => sb.events(Number(f.replace(/\.log$/, ""))))
    .filter((e) => e.kind === "start" && e.sessionId === sessionId);
}

function allSubmits(sb: Sandbox): Array<string | undefined> {
  const dir = path.join(sb.agentDir, "fake-pi");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .flatMap((f) => sb.events(Number(f.replace(/\.log$/, ""))))
    .filter((e) => e.kind === "submit")
    .map((e) => e.text);
}

async function closedSession(sb: Sandbox, svc: PiHostService, prompt: string): Promise<SessionRow> {
  const started = await svc.startSession({ prompt, cwd: sb.home });
  const live = await rowFor(
    sb,
    svc,
    (r) => r.pid === started.pid && r.messages >= 2 && r.state === "idle",
    `idle ${prompt}`,
  );
  await svc.sendPrompt(live, "/quit");
  return rowFor(sb, svc, (r) => r.sessionId === live.sessionId && !r.live, `closed ${prompt}`);
}

describe("wave 5 fixes on an isolated tmux server", () => {
  let sb: Sandbox;
  let svc: PiHostService;

  beforeAll(() => {
    sb = createSandbox();
    svc = sb.service();
  });
  afterAll(() => sb?.cleanup());

  it("a concurrent resume and send start exactly one pi and deliver the prompt once", async () => {
    const closed = await closedSession(sb, svc, "race one");
    const before = startsOf(sb, closed.sessionId).length;
    const [started] = await Promise.all([
      svc.resumeSession(closed),
      svc.sendPrompt(closed, "joined prompt\nsecond line"),
    ]);
    await sb.waitFor(
      () => allSubmits(sb).includes("joined prompt\nsecond line"),
      10_000,
      "joined submit",
    );
    await new Promise((r) => setTimeout(r, 800));
    expect(startsOf(sb, closed.sessionId).length - before).toBe(1);
    expect(allSubmits(sb).filter((t) => t === "joined prompt\nsecond line")).toHaveLength(1);
    expect(sb.events(started.pid).some((e) => e.kind === "submit")).toBe(true);
  });

  it("two concurrent sends to a closed session share one resume and each arrive once", async () => {
    const closed = await closedSession(sb, svc, "race two");
    const before = startsOf(sb, closed.sessionId).length;
    await Promise.all([svc.sendPrompt(closed, "send A"), svc.sendPrompt(closed, "send B")]);
    await sb.waitFor(
      () => allSubmits(sb).includes("send A") && allSubmits(sb).includes("send B"),
      10_000,
      "both submits",
    );
    await new Promise((r) => setTimeout(r, 800));
    expect(startsOf(sb, closed.sessionId).length - before).toBe(1);
    expect(allSubmits(sb).filter((t) => t === "send A")).toHaveLength(1);
    expect(allSubmits(sb).filter((t) => t === "send B")).toHaveLength(1);
  });

  it("the host refuses a resume while an alive live record names the session (ERR live)", async () => {
    const started = await svc.startSession({ prompt: "already open", cwd: sb.home });
    const live = await rowFor(sb, svc, (r) => r.pid === started.pid && r.messages >= 2, "live");
    const env = await svc.probe();
    const windowsBefore = sb.tmux("list-windows", "-a", "-F", "#{window_id}");
    const nonce = makeNonce();
    const res = await sb.connection.exec(
      wrapForAnyShell(
        startScript({
          nonce,
          tmux: env.tmuxPath,
          socket: env.tmuxSocket,
          cwd: sb.home,
          cwdFallbackHome: true,
          windowName: "pi-resume",
          env: [],
          argv: [
            ...(env.piKind === "node" ? [env.nodePath] : []),
            env.piCliPath,
            "--session",
            live.sessionFile!,
          ],
          refuseLive: { procsDir: env.procsDir, sessionId: live.sessionId },
        }),
      ),
    );
    expect(res.stdout).toContain(`${nonce} ERR live ${started.pid}`);
    expect(sb.tmux("list-windows", "-a", "-F", "#{window_id}")).toBe(windowsBefore);
  });

  it("never glues onto an unsent draft: refuses (pane-busy draft), then sends once it is cleared", async () => {
    const started = await svc.startSession({ prompt: "draft host", cwd: sb.home });
    const row = await rowFor(
      sb,
      svc,
      (r) => r.pid === started.pid && r.state === "idle" && r.messages >= 2,
      "idle",
    );
    sb.tmux("send-keys", "-t", started.pane, "-l", "half typed");
    await sb.waitFor(
      () => sb.tmux("capture-pane", "-p", "-t", started.pane).includes("half typed"),
      5000,
      "draft drawn",
    );
    await expect(svc.sendPrompt(row, "from phone")).rejects.toSatisfy(
      (e: unknown) => e instanceof PaneBusyError && e.reason === "draft" && e.code === "pane-busy",
    );
    // The draft is untouched.
    expect(sb.tmux("capture-pane", "-p", "-t", started.pane)).toContain("half typed");
    expect(submitTexts(sb, started.pid)).not.toContain("from phone");
    sb.tmux("send-keys", "-t", started.pane, "C-u");
    await svc.sendPrompt(row, "from phone");
    const texts = await sb.waitFor(
      () => {
        const t = submitTexts(sb, started.pid);
        return t.includes("from phone") ? t : undefined;
      },
      5000,
      "submit after clear",
    );
    expect(texts.filter((t) => t?.includes("half typed"))).toHaveLength(0);
  });

  it("strips control sequences: an ESC[201~ mid-prompt cannot end the paste", async () => {
    const started = await svc.startSession({ cwd: sb.home });
    const row = await rowFor(sb, svc, (r) => r.pid === started.pid, "row");
    await svc.sendPrompt(row, "a\x1b[201~b\r\nc\x07d");
    const submit = await sb.waitForEvent(started.pid, (e) => e.kind === "submit", 5000, "submit");
    expect(submit).toMatchObject({ text: "a[201~b\ncd", pasted: true });
    const input = sb
      .events(started.pid)
      .filter((e) => e.kind === "input")
      .map((e) => e.hex)
      .join("");
    expect(input).toBe(`${hex("\x1b[200~")}${hex("a[201~b\ncd")}${hex("\x1b[201~")}0d`);
  });

  it("reports a send whose result never came back as outcome-unknown", async () => {
    const started = await svc.startSession({ prompt: "timeouts", cwd: sb.home });
    const row = await rowFor(sb, svc, (r) => r.pid === started.pid && r.messages >= 2, "row");
    let mode: "timeout" | "killed" | "pass" = "pass";
    const conn: SshConnection = {
      exec: (command, options) => {
        if (mode === "timeout")
          return Promise.reject(
            new SshError(SSH_ERROR_CODES.TIMEOUT, "Command timed out after 30000ms"),
          );
        if (mode === "killed") return Promise.resolve({ stdout: "", stderr: "", exitCode: 124 });
        return sb.connection.exec(command, options);
      },
      onClose: (l) => sb.connection.onClose(l),
      isConnected: () => true,
      close: () => undefined,
    };
    const wrapped = createHostService(conn, {
      agentDir: sb.agentDir,
      tmuxSocket: sb.socket,
      useLoginShell: false,
    });
    await wrapped.probe();
    mode = "timeout";
    await expect(wrapped.sendPrompt(row, "maybe")).rejects.toBeInstanceOf(HostOutcomeUnknownError);
    mode = "killed";
    await expect(wrapped.sendPrompt(row, "maybe")).rejects.toBeInstanceOf(HostOutcomeUnknownError);
    // Reads are not mutating: a timed-out listing is an ordinary failure.
    mode = "timeout";
    await expect(wrapped.listSessions()).rejects.not.toBeInstanceOf(HostOutcomeUnknownError);
  });

  it("probes tmux 3.1 and an unparseable version without failing", async () => {
    const real = fs.realpathSync(path.join(sb.bin, "tmux"));
    for (const version of ["tmux master", "tmux 3.1c"]) {
      const odd = createSandbox();
      try {
        fs.rmSync(path.join(odd.bin, "tmux"));
        fs.writeFileSync(
          path.join(odd.bin, "tmux"),
          `#!/bin/sh\nif [ "$1" = -V ]; then echo '${version}'; exit 0; fi\nexec '${real}' "$@"\n`,
          { mode: 0o755 },
        );
        const oddSvc = odd.service();
        const env = await oddSvc.probe();
        expect(env.tmuxVersion).toEqual(version === "tmux master" ? undefined : [3, 1]);
      } finally {
        odd.cleanup();
      }
    }
  });
});

describe("tmux server environment, argv and # in paths", () => {
  it("a tmux server the app starts gets the login shell's LANG/LC_* and PATH globally", async () => {
    const sb = createSandbox();
    try {
      fs.writeFileSync(path.join(sb.home, ".profile"), "export LC_TIME=C.UTF-8\n");
      const svc = sb.service({ useLoginShell: true });
      const env = await svc.probe();
      expect(env.serverEnv).toEqual(expect.arrayContaining(["LC_TIME=C.UTF-8", "LANG=C.UTF-8"]));
      const started = await svc.startSession({ prompt: "env", cwd: sb.home });
      expect(started.tmuxSession).toBe("pi");
      const global = sb.tmux("show-environment", "-g");
      expect(global).toContain("LC_TIME=C.UTF-8\n");
      expect(global).toContain("LANG=C.UTF-8\n");
      expect(global).toMatch(
        new RegExp(`^PATH=${sb.bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"),
      );
      // A later window (not started by the app) sees them too.
      sb.tmux(
        "new-window",
        "-d",
        "-t",
        "pi:",
        "sh",
        "-c",
        'env > "$HOME/later-env.tmp" && mv "$HOME/later-env.tmp" "$HOME/later-env"; sleep 5',
      );
      await sb.waitFor(() => fs.existsSync(path.join(sb.home, "later-env")), 5000, "later env");
      expect(fs.readFileSync(path.join(sb.home, "later-env"), "utf8")).toContain("LC_TIME=C.UTF-8");
    } finally {
      sb.cleanup();
    }
  });

  it("runs a one-element pi command whose path has spaces (no $SHELL -c split)", async () => {
    const sb = createSandbox();
    try {
      const toolDir = path.join(sb.dir, "my tools");
      fs.mkdirSync(toolDir);
      const wrapper = path.join(toolDir, "pi");
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_PI}' "$@"\n`, {
        mode: 0o755,
      });
      fs.rmSync(path.join(sb.bin, "pi"));
      fs.symlinkSync(wrapper, path.join(sb.bin, "pi"));
      // With a one-element argv tmux would run `$SHELL -c '<path>'`, splitting at the space.
      const svc = sb.service();
      const env = await svc.probe();
      expect(env.piKind).toBe("exec");
      expect(env.piCliPath).toBe(wrapper);
      const started = await svc.startSession({ cwd: sb.home });
      await sb.waitForEvent(started.pid, (e) => e.kind === "start", 10_000, "start");
      await rowFor(sb, svc, (r) => r.pid === started.pid, "row");
    } finally {
      sb.cleanup();
    }
  });

  it("resumes into a $HOME containing # when the session's folder is gone", async () => {
    const sb = createSandbox();
    try {
      const svc = sb.service();
      const work = path.join(sb.dir, "work");
      fs.mkdirSync(work);
      const started = await svc.startSession({ prompt: "hash home", cwd: work });
      const live = await rowFor(
        sb,
        svc,
        (r) => r.pid === started.pid && r.messages >= 2 && r.state === "idle",
        "row",
      );
      await svc.sendPrompt(live, "/quit");
      const closed = await rowFor(
        sb,
        svc,
        (r) => r.sessionId === live.sessionId && !r.live,
        "closed",
      );
      fs.rmSync(work, { recursive: true });
      const hashHome = path.join(sb.dir, "ho#me #{pane_id}");
      fs.mkdirSync(hashHome);
      sb.env.HOME = hashHome;
      const again = await svc.resumeSession(closed);
      const start = await sb.waitForEvent(again.pid, (e) => e.kind === "start", 10_000, "start");
      expect(start.cwd).toBe(hashHome);
    } finally {
      sb.cleanup();
    }
  });
});
