// HostService end to end on this machine: LocalConnection (sh -c), a private tmux server
// (`-S <tmp>/tmux/sock`), a temp agent dir and a fake pi (test-support/fake-pi.mjs).
// Never touches the user's tmux server or ~/.pi.

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { remoteFor } from "@/remote/for-service";
import { SSH_ERROR_CODES, SshError } from "@/ssh/errors";
import type { SshConnection } from "@/ssh/types";

import { makeNonce, shQuote, startScript, wrapForAnyShell } from "./commands";
import { HostOutcomeUnknownError } from "./errors";
import { createSandbox, FAKE_PI, type FakeEvent, type Sandbox } from "./test-support/sandbox";
import { createHostService, type PiHostService } from "./service";
import { HostError, type SessionRow } from "./types";

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
    expect(started.tmuxSession).toBe("Pi");
    expect(started.pane).toMatch(/^%\d+$/);
    expect(started.windowId).toMatch(/^@\d+$/);
    const start = await sb.waitForEvent(
      started.pid,
      (e) => e.kind === "start",
      10_000,
      "fake pi start",
    );
    expect(start.argv).toEqual(["--model", "prov/model-x", "--thinking", "high"]);
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
    expect(second.tmuxSession).toBe("Pi");
    expect(second.windowId).not.toBe(started.windowId);
    const start2 = await sb.waitForEvent(
      second.pid,
      (e) => e.kind === "start",
      10_000,
      "second start",
    );
    // Prompts no longer enter argv, so @file is literal text; no model/thinking flags when absent.
    expect(start2.argv).toEqual([]);
    expect(
      sb.tmux("list-windows", "-t", "=Pi:", "-F", "#{window_name}").trim().split("\n"),
    ).toEqual(expect.arrayContaining(["its-HOME-id", "file.ts-what-is"]));
  });

  it("rejects a missing cwd", async () => {
    await expectHostError(
      svc.startSession({ prompt: "x", cwd: path.join(sb.dir, "nope") }),
      "not-found",
    );
  });

  it("sends a hostile multi-line prompt through native input without touching terminal keys", async () => {
    const started = await svc.startSession({ cwd: sb.home });
    await sb.waitForEvent(started.pid, (e) => e.kind === "start", 10_000, "start");
    const row = await rowFor(sb, svc, (r) => r.pid === started.pid, "empty session row");
    expect(row.section).toBe("needs"); // never prompted
    expect(row.detail).toBe("send a prompt to start");
    const text = `line 1 'q' "dq" $HOME \`id\` $(id)\nline 2 ; \\ end;\n\tünïcødé ✓ 🎉\n#{pane_id}`;
    await svc.sendPrompt(row, text);
    const submit = await sb.waitForEvent(started.pid, (e) => e.kind === "submit", 5000, "submit");
    expect(submit.text).toBe(text);
    expect(submit.pasted).toBe(false);
    const input = sb
      .events(started.pid)
      .filter((e) => e.kind === "input")
      .map((e) => e.hex)
      .join("");
    expect(input).toBe("");
  });

  it("refuses while pi shows a dialog, but safely sends natively while the pane is in copy mode", async () => {
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
    await svc.sendPrompt(row, "during copy mode");
    expect(submitTexts(sb, started.pid)).toContain("during copy mode");
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

  it("legacy sending reports compatibility/reload for empty and nonempty editors without touching drafts", async () => {
    const legacy = createSandbox();
    legacy.env.FAKE_PI_REMOTE = "0";
    try {
      const service = legacy.service();
      const started = await service.startSession({ cwd: legacy.home });
      const row = await rowFor(legacy, service, (r) => r.pid === started.pid, "legacy row");
      await expect(service.sendPrompt(row, "mobile")).rejects.toMatchObject({
        message: expect.stringContaining("voluntarily reload"),
      });
      legacy.tmux("send-keys", "-t", started.pane, "-l", "desktop α");
      await legacy.waitFor(
        () => legacy.tmux("capture-pane", "-p", "-t", started.pane).includes("desktop α"),
        5000,
        "legacy draft",
      );
      await expect(service.sendPrompt(row, "mobile")).rejects.toMatchObject({
        message: expect.stringContaining("voluntarily reload"),
      });
      expect(legacy.tmux("capture-pane", "-p", "-t", started.pane)).toContain("desktop α");
      expect(submitTexts(legacy, started.pid)).toEqual([]);
    } finally {
      legacy.cleanup();
    }
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
      pasted: false,
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
    expect(again.tmuxSession).toBe("Pi");
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

  it("starts a prompt over 8 KiB empty, then submits it natively once pi is ready", async () => {
    const big = `${"x".repeat(9000)}\nend`;
    const started = await svc.startSession({ prompt: big, cwd: sb.home });
    await sb.waitForEvent(started.pid, (e) => e.kind === "submit", 10_000, "big submit");
    const ev = sb.events(started.pid);
    expect(ev.find((e) => e.kind === "start")?.argv).toEqual([]);
    expect(ev.find((e) => e.kind === "submit")).toMatchObject({ text: big, pasted: false });
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

describe("app windows belong only to exact Pi on isolated sockets", () => {
  it.each([false, true])(
    "ignores other sessions when Pi exists=%s, for new starts and completed resumes",
    async (exists) => {
      const sb = createSandbox();
      try {
        if (exists) sb.tmux("new-session", "-d", "-s", "Pi", "sleep", "60");
        const others = ["0", "work", "Pi2", "pi"];
        for (const name of others) sb.tmux("new-session", "-d", "-s", name, "sleep", "60");
        const before = others.map((name) =>
          sb.tmux("list-windows", "-t", `=${name}:`, "-F", "#{window_id}"),
        );
        const svc = sb.service();
        const started = await svc.startSession({ prompt: "fix the flaky test", cwd: sb.home });
        expect(started.tmuxSession).toBe("Pi");
        expect(sb.tmux("display-message", "-p", "-t", started.pane, "#{window_name}").trim()).toBe(
          "fix-the-flaky",
        );
        const windows = sb
          .tmux("list-windows", "-t", "=Pi:", "-F", "#{pane_id}")
          .trim()
          .split("\n");
        expect(windows).toHaveLength(exists ? 2 : 1);
        if (!exists) expect(windows).toEqual([started.pane]);
        const live = await rowFor(
          sb,
          svc,
          (r) => r.pid === started.pid && r.state === "idle",
          "new Pi row",
        );
        await svc.sendPrompt(live, "/quit");
        const closed = await rowFor(
          sb,
          svc,
          (r) => r.sessionId === live.sessionId && !r.live,
          "closed Pi row",
        );
        const resumed = await svc.resumeSession(closed);
        expect(resumed.tmuxSession).toBe("Pi");
        expect(sb.tmux("display-message", "-p", "-t", resumed.pane, "#{window_name}").trim()).toBe(
          "pi-resume",
        );
        expect(
          others.map((name) => sb.tmux("list-windows", "-t", `=${name}:`, "-F", "#{window_id}")),
        ).toEqual(before);
      } finally {
        sb.cleanup();
      }
    },
  );

  it("two simultaneous launches when Pi is absent create one session and two pi windows", async () => {
    const sb = createSandbox();
    try {
      const real = fs.realpathSync(path.join(sb.bin, "tmux"));
      const barrier = path.join(sb.dir, "barrier");
      fs.mkdirSync(barrier);
      fs.rmSync(path.join(sb.bin, "tmux"));
      // Both has-session calls must observe absence before either can create Pi.
      fs.writeFileSync(
        path.join(sb.bin, "tmux"),
        `#!/bin/sh
if [ "$3" = has-session ]; then
  '${real}' "$@" 2>/dev/null; status=$?
  mkdir '${barrier}'/$$
  while [ "$(ls '${barrier}' | wc -l)" -lt 2 ]; do sleep 0.05; done
  exit "$status"
fi
if [ "$3" = new-session ]; then
  '${real}' "$@" 2>'${barrier}'/error-$$; status=$?
  cat '${barrier}'/error-$$ >&2
  exit "$status"
fi
exec '${real}' "$@"
`,
        { mode: 0o755 },
      );
      const svc = sb.service();
      await svc.probe();
      const started = await Promise.all([
        svc.startSession({ cwd: sb.home }),
        svc.startSession({ cwd: sb.home }),
      ]);
      expect(started.map((s) => s.tmuxSession)).toEqual(["Pi", "Pi"]);
      expect(new Set(started.map((s) => s.pane)).size).toBe(2);
      expect(sb.tmux("list-sessions", "-F", "#{session_name}").trim()).toBe("Pi");
      expect(
        sb.tmux("list-windows", "-t", "=Pi:", "-F", "#{window_name}").trim().split("\n"),
      ).toEqual(["pi", "pi"]);
      const errors = fs
        .readdirSync(barrier)
        .filter((file) => file.startsWith("error-"))
        .map((file) => fs.readFileSync(path.join(barrier, file), "utf8"))
        .join("");
      expect(errors).toContain("duplicate session: Pi");
      for (const session of started) await sb.waitForEvent(session.pid, (e) => e.kind === "start");
    } finally {
      sb.cleanup();
    }
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

  it("a command resumes a completed session once and uses its new native channel", async () => {
    const closed = await closedSession(sb, svc, "command resume");
    const before = startsOf(sb, closed.sessionId).length;
    await svc.runCommand(closed, "/compact");
    const live = await rowFor(
      sb,
      svc,
      (r) => r.live && r.sessionId === closed.sessionId,
      "command resumed",
    );
    expect(live.pid).not.toBe(closed.pid);
    expect(startsOf(sb, closed.sessionId).length - before).toBe(1);
    expect(sb.events(live.pid!).filter((e) => e.action === "command.run")).toMatchObject([
      { line: "/compact" },
    ]);
    expect(submitTexts(sb, live.pid!)).toEqual([]);
  });

  it("concurrent send and command share one reopen", async () => {
    const closed = await closedSession(sb, svc, "command send race");
    const before = startsOf(sb, closed.sessionId).length;
    await Promise.all([
      svc.sendPrompt(closed, "joined command send"),
      svc.runCommand(closed, "/compact"),
    ]);
    const live = await rowFor(
      sb,
      svc,
      (r) => r.live && r.sessionId === closed.sessionId,
      "joined command row",
    );
    expect(startsOf(sb, closed.sessionId).length - before).toBe(1);
    expect(submitTexts(sb, live.pid!).filter((t) => t === "joined command send")).toHaveLength(1);
    expect(sb.events(live.pid!).filter((e) => e.action === "command.run")).toHaveLength(1);
  });

  it("polling a completed session never resumes it", async () => {
    const closed = await closedSession(sb, svc, "read only command");
    const before = startsOf(sb, closed.sessionId).length;
    await svc.listSessions();
    await svc.readChat(closed);
    expect(await remoteFor(svc).readState(closed)).toBeUndefined();
    expect(startsOf(sb, closed.sessionId)).toHaveLength(before);
    expect(
      (await svc.listSessions()).rows.find((r) => r.sessionId === closed.sessionId)?.live,
    ).toBe(false);
  });

  it("a native model picker resumes without sending /model as terminal input", async () => {
    const closed = await closedSession(sb, svc, "native picker resume");
    const before = startsOf(sb, closed.sessionId).length;
    const ready = await svc.ensureRemoteSession(closed, "/model");
    expect(ready.row.pid).not.toBe(closed.pid);
    expect(ready.state.sessionId).toBe(closed.sessionId);
    const result = await remoteFor(svc).send(
      ready.row,
      "models.list",
      {},
      { sessionId: closed.sessionId },
    );
    expect(result.data).toMatchObject({ available: expect.any(Array) });
    await remoteFor(svc).send(
      ready.row,
      "model.set",
      { ref: "openai/gpt-6" },
      { sessionId: closed.sessionId },
    );
    expect(startsOf(sb, closed.sessionId).length - before).toBe(1);
    expect(submitTexts(sb, ready.row.pid!)).toEqual([]);
    expect(sb.events(ready.row.pid!).filter((e) => e.action === "command.run")).toEqual([]);
  });

  it("a mismatched channel identity refuses a command without retargeting or reopening", async () => {
    const started = await svc.startSession({ prompt: "identity command", cwd: sb.home });
    const live = await rowFor(
      sb,
      svc,
      (r) => r.pid === started.pid && r.messages >= 2 && r.state === "idle",
      "identity command row",
    );
    const file = path.join(sb.remoteDir(started.pid), "state.json");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...state, sessionId: "replacement" }));
    fs.renameSync(`${file}.tmp`, file);
    const before = startsOf(sb, live.sessionId).length;
    await expect(sb.service({ readyTimeoutMs: 1 }).runCommand(live, "/compact")).rejects.toThrow();
    expect(startsOf(sb, live.sessionId)).toHaveLength(before);
    expect(sb.events(started.pid).filter((e) => e.action === "command.run")).toEqual([]);
  });

  it("command resume refuses a missing working folder", async () => {
    const cwd = path.join(sb.dir, "command-cwd");
    fs.mkdirSync(cwd);
    const started = await svc.startSession({ prompt: "command cwd", cwd });
    const live = await rowFor(
      sb,
      svc,
      (r) => r.pid === started.pid && r.messages >= 2 && r.state === "idle",
      "command cwd row",
    );
    await svc.sendPrompt(live, "/quit");
    const closed = await rowFor(
      sb,
      svc,
      (r) => r.sessionId === live.sessionId && !r.live,
      "closed cwd row",
    );
    fs.rmdirSync(cwd);
    const before = startsOf(sb, closed.sessionId).length;
    await expectHostError(svc.runCommand(closed, "/compact"), "not-found");
    expect(startsOf(sb, closed.sessionId)).toHaveLength(before);
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

  it("native send preserves an actual desktop draft and submits only mobile text once", async () => {
    const started = await svc.startSession({ prompt: "draft host", cwd: sb.home });
    const row = await rowFor(
      sb,
      svc,
      (r) => r.pid === started.pid && r.state === "idle" && r.messages >= 2,
      "idle",
    );
    sb.tmux("send-keys", "-t", started.pane, "-l", "half typed α");
    await sb.waitFor(
      () => sb.tmux("capture-pane", "-p", "-t", started.pane).includes("half typed α"),
      5000,
      "draft drawn",
    );
    await svc.sendPrompt(row, "from phone\n日本語");
    expect(sb.tmux("capture-pane", "-p", "-t", started.pane)).toContain("half typed α");
    expect(submitTexts(sb, started.pid).filter((t) => t === "from phone\n日本語")).toHaveLength(1);
    expect(submitTexts(sb, started.pid).filter((t) => t?.includes("half typed"))).toHaveLength(0);
  });

  it("strips control sequences: an ESC[201~ mid-prompt cannot end the paste", async () => {
    const started = await svc.startSession({ cwd: sb.home });
    const row = await rowFor(sb, svc, (r) => r.pid === started.pid, "row");
    await svc.sendPrompt(row, "a\x1b[201~b\r\nc\x07d");
    const submit = await sb.waitForEvent(started.pid, (e) => e.kind === "submit", 5000, "submit");
    expect(submit).toMatchObject({ text: "a[201~b\ncd", pasted: false });
    const input = sb
      .events(started.pid)
      .filter((e) => e.kind === "input")
      .map((e) => e.hex)
      .join("");
    expect(input).toBe("");
  });

  it("reports a send whose result never came back as outcome-unknown", async () => {
    const started = await svc.startSession({ prompt: "timeouts", cwd: sb.home });
    const row = await rowFor(sb, svc, (r) => r.pid === started.pid && r.messages >= 2, "row");
    let mode: "timeout" | "killed" | "read-timeout" | "pass" = "pass";
    const conn: SshConnection = {
      exec: (command, options) => {
        const scriptB64 = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d/.exec(command)?.[1] ?? "";
        const isNativeSend = Buffer.from(scriptB64, "base64").toString("utf8").includes("NOINBOX");
        if (mode === "read-timeout")
          return Promise.reject(new SshError(SSH_ERROR_CODES.TIMEOUT, "Read timed out"));
        if (mode === "timeout" && isNativeSend)
          return sb.connection.exec(command, options).then(() => {
            throw new SshError(SSH_ERROR_CODES.TIMEOUT, "Command timed out after 30000ms");
          });
        if (mode === "killed" && isNativeSend)
          return Promise.resolve({ stdout: "", stderr: "", exitCode: 124 });
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
    expect(submitTexts(sb, started.pid).filter((text) => text === "maybe")).toHaveLength(1);
    mode = "killed";
    await expect(wrapped.sendPrompt(row, "maybe")).rejects.toBeInstanceOf(HostOutcomeUnknownError);
    // Reads are not mutating: a timed-out listing is an ordinary failure.
    mode = "read-timeout";
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
      expect(started.tmuxSession).toBe("Pi");
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
        "=Pi:",
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

  it("creating Pi leaves an existing work server environment and future work windows unchanged", async () => {
    const sb = createSandbox();
    try {
      sb.tmux("new-session", "-d", "-s", "work", "-e", "PATH=/usr/bin:/bin", "sleep", "60");
      sb.tmux("set-environment", "-g", "PATH", "/usr/bin:/bin");
      sb.tmux("set-environment", "-g", "LANG", "C");
      sb.tmux("set-environment", "-g", "LC_TIME", "C");
      const before = sb.tmux("show-environment", "-g");
      const started = await sb.service().startSession({ cwd: sb.home });
      expect(started.tmuxSession).toBe("Pi");
      expect(sb.tmux("show-environment", "-g")).toBe(before);
      const piEnv = sb.tmux("show-environment", "-t", "=Pi");
      expect(piEnv).toContain(`PATH=${sb.bin}\n`);
      expect(piEnv).toContain("LANG=C.UTF-8\n");
      // tmux takes PATH from the new-window client, not just its stored environment.
      const laterWindow = await sb.connection.exec(
        wrapForAnyShell(
          `env PATH=/usr/bin:/bin ${shQuote(fs.realpathSync(path.join(sb.bin, "tmux")))} -S ${shQuote(sb.socket)} new-window -d -t '=work:' sh -c ${shQuote('env > "$HOME/work-env.tmp" && mv "$HOME/work-env.tmp" "$HOME/work-env"; sleep 5')}`,
        ),
      );
      expect(laterWindow.exitCode).toBe(0);
      await sb.waitFor(() => fs.existsSync(path.join(sb.home, "work-env")), 5000, "work env");
      const later = fs.readFileSync(path.join(sb.home, "work-env"), "utf8");
      expect(later).toContain("PATH=/usr/bin:/bin\n");
      expect(later).toContain("LANG=C\n");
      expect(later).toContain("LC_TIME=C\n");
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
