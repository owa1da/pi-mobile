// The remote channel end to end on this machine: the real client (scripts over LocalConnection,
// `sh -c`) against the fake pi's forge side (test-support/fake-pi.mjs) in an isolated sandbox
// (temp agent dir, private tmux server). Never touches the user's tmux server or ~/.pi.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSandbox, type FakeEvent, type Sandbox } from "@/host/test-support/sandbox";
import type { PiHostService } from "@/host/service";
import type { SessionRow } from "@/host/types";
import { connectionRunner, createRemoteClient, type RemoteClient } from "./client";
import { RemoteError } from "./errors";
import { openQuestions } from "./parse";
import type { RemoteState } from "./types";

async function rowFor(
  svc: PiHostService,
  pred: (r: SessionRow) => boolean,
  label: string,
): Promise<SessionRow> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const snap = await svc.listSessions();
    const found = snap.rows.find(pred);
    if (found) return found;
    if (Date.now() > deadline)
      throw new Error(`no row: ${label}\n${JSON.stringify(snap.rows, null, 1)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function stateWhere(
  client: RemoteClient,
  row: SessionRow,
  pred: (s: RemoteState) => boolean,
  label: string,
): Promise<RemoteState> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = await client.readState(row);
    if (state && pred(state)) return state;
    if (Date.now() > deadline)
      throw new Error(`state never matched: ${label}\n${JSON.stringify(state, null, 1)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const remoteEvents = (sb: Sandbox, pid: number): FakeEvent[] =>
  sb.events(pid).filter((e) => e.kind === "remote" && e.action);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof RemoteError) return error.code;
    throw error;
  }
}

describe("remote channel against the fake pi's forge side", () => {
  let sb: Sandbox;
  let svc: PiHostService;
  let client: RemoteClient;
  let row: SessionRow;
  let pid: number;

  beforeAll(async () => {
    sb = createSandbox();
    svc = sb.service();
    client = createRemoteClient({
      run: connectionRunner(sb.connection),
      agentDir: async () => (await svc.environment()).agentDir,
    });
    const started = await svc.startSession({ prompt: "hello", cwd: sb.home });
    pid = started.pid;
    row = await rowFor(
      svc,
      (r) => r.pid === pid && r.state === "idle" && r.messages >= 2,
      "idle remote row",
    );
  });

  afterAll(() => sb?.cleanup());

  it("lists remote: 1 and publishes state with commands and footer, no dialog", async () => {
    expect(row.remote).toBe(1);
    const state = await client.readState(row);
    expect(state).toMatchObject({ v: 1, pid, prompt: null, questions: [] });
    expect(state?.commands?.map((c) => c.name)).toContain("compact");
    expect(state?.footer?.contextWindow).toBe(200000);
  });

  it("answers a select: invalid value refused, an option resolves it once, a repeat is stale", async () => {
    process.kill(pid, "SIGUSR2");
    const waiting = await rowFor(svc, (r) => r.pid === pid && r.state === "waiting", "waiting");
    const state = await stateWhere(client, waiting, (s) => Boolean(s.prompt), "select open");
    const prompt = state.prompt!;
    expect(prompt).toMatchObject({ kind: "select", options: ["Allow", "Deny"], answerable: true });
    expect(
      await codeOf(client.send(row, "prompt.respond", { id: prompt.id, value: "Maybe" })),
    ).toBe("invalid");
    const ok = await client.send(row, "prompt.respond", { id: prompt.id, value: "Allow" });
    expect(ok).toMatchObject({ ok: true, code: "ok" });
    expect(await codeOf(client.send(row, "prompt.respond", { id: prompt.id, value: "Deny" }))).toBe(
      "stale",
    );
    const answered = remoteEvents(sb, pid).filter((e) => e.action === "prompt.respond");
    expect(answered).toEqual([
      expect.objectContaining({ by: "app", id: prompt.id, value: "Allow", cancel: false }),
    ]);
    // The answer reaches the session transcript and pi leaves the dialog.
    expect(fs.readFileSync(row.sessionFile!, "utf8")).toContain("Allow bash? → Allow");
    await rowFor(svc, (r) => r.pid === pid && r.state === "idle", "idle after answer");
    // No result file is left behind.
    expect(fs.readdirSync(`${sb.remoteDir(pid)}/results`)).toEqual([]);
  });

  it("answers confirm, input and editor; cancels too", async () => {
    sb.control(pid, { op: "prompt", kind: "confirm", title: "Overwrite README.md?" });
    let s = await stateWhere(client, row, (x) => x.prompt?.kind === "confirm", "confirm");
    await client.send(row, "prompt.respond", { id: s.prompt!.id, value: "No" });
    sb.control(pid, {
      op: "prompt",
      kind: "input",
      title: "Branch name",
      placeholder: "feature/…",
    });
    s = await stateWhere(client, row, (x) => x.prompt?.kind === "input", "input");
    await client.send(row, "prompt.respond", { id: s.prompt!.id, value: "fix/login-loop" });
    sb.control(pid, { op: "prompt", kind: "editor", title: "Commit message", prefill: "fix: x\n" });
    s = await stateWhere(client, row, (x) => x.prompt?.kind === "editor", "editor");
    expect(s.prompt?.prefill).toBe("fix: x\n");
    await client.send(row, "prompt.respond", { id: s.prompt!.id, cancel: true });
    const values = remoteEvents(sb, pid)
      .filter((e) => e.action === "prompt.respond")
      .slice(-3)
      .map((e) => (e.cancel ? "cancel" : e.value));
    expect(values).toEqual(["No", "fix/login-loop", "cancel"]);
  });

  it("refuses a custom dialog (answer it on the computer)", async () => {
    sb.control(pid, { op: "prompt", kind: "custom", title: "MCP servers" });
    const s = await stateWhere(client, row, (x) => x.prompt?.kind === "custom", "custom");
    expect(s.prompt?.answerable).toBe(false);
    expect(await codeOf(client.send(row, "prompt.respond", { id: s.prompt!.id, value: "x" }))).toBe(
      "refused",
    );
    sb.control(pid, { op: "clear" });
    await stateWhere(client, row, (x) => x.prompt === null, "cleared");
  });

  it("answers a multi-question ask_user item, validates picks, and dismisses another", async () => {
    sb.control(pid, [
      {
        op: "ask",
        blocking: false,
        items: [{ question: "Later?", options: [{ label: "yes" }] }],
      },
      {
        op: "ask",
        items: [
          {
            question: "Which database?",
            header: "DB",
            options: [{ label: "Postgres" }, { label: "SQLite", description: "file based" }],
          },
          {
            question: "Which checks?",
            header: "Checks",
            multiSelect: true,
            options: [{ label: "lint" }, { label: "types" }, { label: "tests" }],
          },
        ],
      },
    ]);
    const s = await stateWhere(client, row, (x) => (x.questions?.length ?? 0) === 2, "asks");
    const [first, second] = openQuestions(s);
    expect(first.blocking).toBe(true);
    expect(first.items[1].multiSelect).toBe(true);
    expect(
      await codeOf(
        client.send(row, "ask.answer", { id: first.id, answers: [{ picked: ["MySQL"] }, null] }),
      ),
    ).toBe("invalid");
    await client.send(row, "ask.answer", {
      id: first.id,
      answers: [{ picked: ["SQLite"] }, { picked: ["lint", "tests"], typed: "and e2e" }],
    });
    await client.send(row, "ask.dismiss", { id: second.id });
    const events = remoteEvents(sb, pid).filter((e) => e.action?.startsWith("ask."));
    expect(events.at(-2)).toMatchObject({
      action: "ask.answer",
      by: "app",
      answers: [{ picked: ["SQLite"] }, { picked: ["lint", "tests"], typed: "and e2e" }],
    });
    expect(events.at(-1)).toMatchObject({ action: "ask.dismiss", id: second.id });
    expect(fs.readFileSync(row.sessionFile!, "utf8")).toContain(
      "Which checks? → lint, tests, and e2e",
    );
    await stateWhere(client, row, (x) => x.questions?.length === 0, "asks closed");
  });

  it("reports stale when the desktop answered first", async () => {
    sb.control(pid, [
      { op: "desktop-first", count: 1 },
      { op: "prompt", kind: "select" },
    ]);
    const s = await stateWhere(client, row, (x) => x.prompt?.kind === "select", "select");
    expect(
      await codeOf(client.send(row, "prompt.respond", { id: s.prompt!.id, value: "Deny" })),
    ).toBe("stale");
    const last = remoteEvents(sb, pid).at(-1);
    expect(last).toMatchObject({ action: "prompt.respond", by: "desktop", value: "Allow" });
  });

  it("reports expired for an action written over 60 s ago", async () => {
    sb.control(pid, { op: "prompt", kind: "confirm", title: "Old?" });
    const s = await stateWhere(client, row, (x) => x.prompt?.kind === "confirm", "confirm");
    const late = createRemoteClient({
      run: connectionRunner(sb.connection),
      agentDir: async () => sb.agentDir,
      now: () => Date.now() - 61_000,
    });
    expect(await codeOf(late.send(row, "prompt.respond", { id: s.prompt!.id, value: "Yes" }))).toBe(
      "expired",
    );
    // The dialog is still open: an expired action does nothing.
    expect((await client.readState(row))?.prompt?.id).toBe(s.prompt!.id);
    await client.send(row, "prompt.respond", { id: s.prompt!.id, cancel: true });
  });

  it("runs a / command, refuses one that opens a TUI view, and names unknown actions", async () => {
    await client.send(row, "command.run", { line: "/compact keep the plan" });
    expect(remoteEvents(sb, pid).at(-1)).toMatchObject({
      action: "command.run",
      line: "/compact keep the plan",
    });
    expect(await codeOf(client.send(row, "command.run", { line: "/tasks" }))).toBe("refused");
    expect(await codeOf(client.send(row, "command.run", { line: "/nope" }))).toBe("invalid");
    expect(await codeOf(client.send(row, "usage.refresh", {}))).toBe("unknown-action");
  });

  it("says no-channel for a process without a remote dir", async () => {
    expect(await client.readState({ ...row, pid: 999_999 })).toBeUndefined();
    expect(await codeOf(client.send({ ...row, pid: 999_999 }, "ask.dismiss", { id: "q" }))).toBe(
      "no-channel",
    );
  });
});
