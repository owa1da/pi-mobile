// Every native-screen action family round-trips against the fake pi's forge side
// (test-support/fake-pi.mjs) over the real client scripts, in an isolated sandbox (temp agent dir,
// private tmux server). Never touches the user's tmux server or ~/.pi.

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSandbox, type FakeEvent, type Sandbox } from "@/host/test-support/sandbox";
import type { PiHostService } from "@/host/service";
import type { SessionRow } from "@/host/types";
import { connectionRunner, createRemoteClient, type RemoteClient } from "./client";
import { RemoteError } from "./errors";
import { readBtwHistory } from "./session-file";
import type { RemoteState } from "./types";
import {
  costSections,
  diffLines,
  exportedPath,
  exportNeedsOverwrite,
  footerParts,
  modelGroups,
  parseChangelog,
  parseCheckpointDiff,
  parseModelList,
  parsePinsResult,
  parseRewindPreview,
  parseSyncStatus,
  parseThinking,
  parseUsage,
  rewindChoices,
  rewindLine,
  syncDone,
  tailText,
} from "./views";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    if (Date.now() > deadline) throw new Error(`no row: ${label}`);
    await sleep(100);
  }
}

async function until<T>(fn: () => Promise<T | undefined | false>, label: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await sleep(150);
  }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof RemoteError) return error.code;
    throw error;
  }
}

const fileHas = (file: string, needle: string) => async () =>
  fs.readFileSync(file, "utf8").includes(needle);

const taskStatus = (s: RemoteState, key: string) => s.tasks?.find((t) => t.key === key)?.status;

const forgeEvents = (sb: Sandbox, pid: number, action: string): FakeEvent[] =>
  sb.events(pid).filter((e) => e.kind === "remote" && e.action === action);

describe("native forge screens against the fake pi", () => {
  let sb: Sandbox;
  let svc: PiHostService;
  let client: RemoteClient;
  let row: SessionRow;
  let pid: number;
  const state = async (pred: (s: RemoteState) => boolean, label: string) =>
    until(async () => {
      const s = await client.readState(row);
      return s && pred(s) ? s : undefined;
    }, label);

  beforeAll(async () => {
    sb = createSandbox();
    svc = sb.service();
    client = createRemoteClient({
      run: connectionRunner(sb.connection),
      agentDir: async () => (await svc.environment()).agentDir,
    });
    const started = await svc.startSession({ prompt: "Add a token bucket", cwd: sb.home });
    pid = started.pid;
    row = await rowFor(svc, (r) => r.pid === pid && r.state === "idle" && r.messages >= 2, "idle");
    for (const [i, text] of ["Write tests for it", "Update the README"].entries()) {
      await svc.sendPrompt(row, text);
      row = await rowFor(
        svc,
        (r) => r.pid === pid && r.state === "idle" && r.messages >= 4 + i * 2,
        `reply ${i}`,
      );
    }
  }, 60_000);

  afterAll(() => sb?.cleanup());

  it("publishes every area: checkpoints, tasks, pins, side, wake, a named footer model", async () => {
    const s = await state((x) => (x.checkpoints?.length ?? 0) >= 3, "three checkpoints");
    expect(s.checkpoints?.map((c) => c.label)).toEqual([
      "Add a token bucket",
      "Write tests for it",
      "Update the README",
    ]);
    expect(s.tasks?.map((t) => t.kind)).toEqual(["shell", "agent", "workflow"]);
    expect(s.pins?.pinned).toContain("openai/gpt-6");
    expect(s.side).toBeNull();
    expect(s.wake).toBeNull();
    expect(s.footer?.model?.name).toBe("Fake 1");
    // v1.2 footer: what the desktop line shows, its items last.
    expect(s.footer).toMatchObject({ compactAt: 83, compactionPaused: false, items: ["1 shell"] });
    expect(footerParts(s.footer).map((p) => p.text)).toEqual([
      "Fake 1",
      "medium",
      "ctx 18%/200k",
      "~$0.126",
      "1 shell",
    ]);
    expect(s.btw).toBeNull();
  });

  it("rewind: previews what each prompt would undo, applies a mode, and says so", async () => {
    const s = await state((x) => (x.checkpoints?.length ?? 0) >= 3, "checkpoints");
    const last = s.checkpoints![2];
    const preview = parseRewindPreview(
      (await client.send(row, "rewind.preview", { entryId: last.entryId })).data,
    );
    expect(preview && rewindLine(preview)).toMatch(/^\d+ files? changed \+\d+/);
    expect(preview).toMatchObject({ entryId: last.entryId, heading: "code", warnings: [] });
    expect(preview?.code?.sentence).toMatch(/^The code will be restored /);
    expect(rewindChoices(preview)).toEqual(["both", "conversation", "code", "cancel"]);
    const first = parseRewindPreview(
      (await client.send(row, "rewind.preview", { entryId: s.checkpoints![0].entryId })).data,
    );
    expect(first?.code?.removed).toBeGreaterThan(preview!.code!.removed);
    expect(
      await codeOf(client.send(row, "rewind.apply", { entryId: last.entryId, mode: "sideways" })),
    ).toBe("invalid");
    const applied = await client.send(row, "rewind.apply", {
      entryId: last.entryId,
      mode: "conversation",
    });
    expect(applied.data).toBeNull();
    expect(applied.message).toBe("Navigated to selected point");
    expect(forgeEvents(sb, pid, "rewind.apply").at(-1)?.args).toEqual({
      entryId: last.entryId,
      mode: "conversation",
    });
    await state((x) => x.checkpoints?.length === 2, "rewound branch");
    expect(fs.readFileSync(row.sessionFile!, "utf8")).toContain("Navigated to selected point");
    expect(await codeOf(client.send(row, "rewind.preview", { entryId: last.entryId }))).toBe(
      "stale",
    );
  });

  it("checkpoints: a diff with +/- lines, and a restore", async () => {
    const diff = parseCheckpointDiff((await client.send(row, "checkpoint.diff", { n: 2 })).data);
    expect(diff?.truncated).toBe(false);
    const kinds = new Set(diffLines(diff!.patch).lines.map((l) => l.kind));
    expect([...kinds]).toEqual(expect.arrayContaining(["file", "hunk", "add", "del", "context"]));
    const restored = await client.send(row, "checkpoint.restore", { n: 2 });
    expect(restored.message).toMatch(/^Restored to checkpoint 2/);
    expect(forgeEvents(sb, pid, "checkpoint.restore").at(-1)?.args).toEqual({ n: 2 });
    expect(await codeOf(client.send(row, "checkpoint.restore", { n: 99 }))).toBe("stale");
  });

  it("tasks: tails a shell, stops it, resumes a workflow; an agent takes a message and resumes", async () => {
    const s = await state((x) => Boolean(x.tasks?.length), "tasks");
    const tail = tailText(
      (await client.send(row, "task.tail", { owner: "main", key: "sh-1", bytes: 4096 })).data,
    );
    expect(tail).toContain("npm test -- --watch");
    await client.send(row, "task.stop", { owner: "main", key: "sh-1" });
    const wf = s.tasks!.find((t) => t.kind === "workflow")!;
    await client.send(row, "task.resume", { runId: wf.runDir!.split("/").pop()! });
    const after = await state((x) => taskStatus(x, "wf-sweep") === "running", "workflow resumed");
    expect(taskStatus(after, "sh-1")).toBe("stopped");
    const agent = after.tasks!.find((t) => t.kind === "agent")!;
    await client.send(row, "agent.send", {
      key: agent.key,
      text: "Also check the timer",
      mode: "followUp",
    });
    await until(fileHas(agent.sessionFile!, "agent: noted"), "agent reply");
    // v1.2: tail is for shells only; a resume carries the user's text.
    expect(await codeOf(client.send(row, "task.tail", { owner: "main", key: agent.key }))).toBe(
      "invalid",
    );
    expect(await codeOf(client.send(row, "agent.resume", { key: agent.key }))).toBe("invalid");
    await client.send(row, "agent.resume", { key: agent.key, text: "Now the timer" });
    await until(fileHas(agent.sessionFile!, "agent: resumed, Now the timer"), "agent resumed");
    expect(forgeEvents(sb, pid, "agent.send").at(-1)?.args).toMatchObject({ mode: "followUp" });
  });

  it("side: opens with text, answers from its own session file, takes a message, closes", async () => {
    await client.send(row, "side.open", { text: "What is a token bucket?" });
    const s = await state((x) => Boolean(x.side?.open && x.side.sessionFile), "side open");
    const file = s.side!.sessionFile!;
    await until(fileHas(file, "side: A token bucket"), "side reply");
    await client.send(row, "side.send", { text: "And a leaky bucket?" });
    await until(fileHas(file, "And a leaky bucket?"), "side message");
    await client.send(row, "side.close", {});
    await state((x) => x.side === null, "side closed");
    expect(await codeOf(client.send(row, "side.send", { text: "x" }))).toBe("stale");
  });

  it("btw: an answer lands in the session's forge-btw entries; fork opens a side; clear empties it", async () => {
    const run = connectionRunner(sb.connection);
    await client.send(row, "btw.ask", { text: "Is a token bucket fair?" });
    const pending = await state((x) => x.btw?.pending === true, "btw pending");
    expect(pending.btw).toEqual({
      open: true,
      pending: true,
      question: "Is a token bucket fair?",
      error: null,
    });
    expect(await codeOf(client.send(row, "btw.ask", { text: "again" }))).toBe("refused");
    const history = await until(async () => {
      const h = await readBtwHistory(run, row.sessionFile!);
      return h.length > 0 ? h : undefined;
    }, "btw answer");
    expect(history.at(-1)?.question).toBe("Is a token bucket fair?");
    await client.send(row, "btw.fork", {});
    await state((x) => Boolean(x.side?.open), "forked side");
    await client.send(row, "side.close", {});
    await client.send(row, "btw.clear", {});
    expect(await readBtwHistory(run, row.sessionFile!)).toEqual([]);
    // A failed answer writes no entry: forge's state says why; Close closes the panel.
    await client.send(row, "btw.ask", { text: "will this fail" });
    const failed = await state((x) => Boolean(x.btw?.error), "btw error");
    expect(failed.btw).toMatchObject({
      open: true,
      pending: false,
      error: "Unknown provider: unknown",
    });
    await client.send(row, "btw.close", {});
    await state((x) => x.btw === null, "btw closed");
    expect(await codeOf(client.send(row, "btw.close", {}))).toBe("stale");
  });

  it("model: lists, groups, sets a model and a thinking level, toggles a pin", async () => {
    const list = parseModelList((await client.send(row, "models.list", {})).data);
    expect(list.current).toBe("fake/fake-1");
    expect(list.thinking?.levels).toContain("high");
    const available = list.available;
    const s0 = await client.readState(row);
    // forge's picker: only the pins until you type, then matching pins and the other models.
    expect(modelGroups(available, s0?.pins).map((g) => g.key)).toEqual(["pinned"]);
    expect(modelGroups(available, s0?.pins, "gemini").map((g) => g.key)).toEqual(["other"]);
    const set = await client.send(row, "model.set", { ref: "anthropic/claude-sonnet-5" });
    expect(set.data).toMatchObject({ ref: "anthropic/claude-sonnet-5" });
    const level = parseThinking((await client.send(row, "thinking.set", { level: "high" })).data);
    expect(level?.level).toBe("high");
    const pinned = await client.send(row, "pin.toggle", { ref: "google/gemini-3-pro" });
    expect(parsePinsResult(pinned.data)?.pinned).toContain("google/gemini-3-pro");
    const s = await state((x) => x.footer?.model?.name === "Sonnet 5", "model set");
    expect(s.footer?.model?.thinking).toBe("high");
    expect(s.pins?.pinned).toContain("google/gemini-3-pro");
    expect(s.pins?.recent).toContain("anthropic/claude-sonnet-5");
    expect(await codeOf(client.send(row, "model.set", { ref: "nope/x" }))).toBe("invalid");
    expect(await codeOf(client.send(row, "thinking.set", { level: "max" }))).toBe("invalid");
  });

  it("usage, cost, changelog and sync read; pause sets and cancels a wake-up", async () => {
    const usage = parseUsage((await client.send(row, "usage.refresh", { force: true })).data);
    expect(usage.map((a) => [a.name, a.plan])).toEqual([
      ["Claude", "Max 20x"],
      ["OpenRouter", "Free tier"],
    ]);
    expect(usage[0].meters[0]).toMatchObject({ label: "5-hour", ratio: 0.93 });
    const cost = costSections((await client.send(row, "cost.read", {})).data);
    expect(cost.map((c) => c.title)).toEqual([null, "Messages", "Tokens", "Cost"]);
    const log = parseChangelog((await client.send(row, "changelog.read", {})).data);
    expect(log.markdown).toContain("## 1.4.0");
    expect(log.truncated).toBe(false);
    expect(parseSyncStatus((await client.send(row, "sync.status", {})).data)).toMatchObject({
      level: "info",
    });
    expect(syncDone((await client.send(row, "sync.run", {})).data)).toBe(true);
    // `in` is seconds (forge reads a number as seconds): 30 minutes.
    await client.send(row, "wake.set", { in: 1800, reason: "waiting for CI" });
    const s = await state((x) => Boolean(x.wake), "wake set");
    expect(s.wake?.reason).toBe("waiting for CI");
    expect(s.wake!.due - Date.now()).toBeGreaterThan(29 * 60_000);
    await client.send(row, "wake.cancel", {});
    await state((x) => x.wake === null, "wake cancelled");
    expect(await codeOf(client.send(row, "wake.set", { in: 0 }))).toBe("invalid");
  });

  it("export: writes the path, asks before overwriting, then overwrites", async () => {
    const first = exportedPath((await client.send(row, "export.run", { path: "notes/a.md" })).data);
    expect(first && fs.existsSync(first)).toBe(true);
    const refused = await client
      .send(row, "export.run", { path: "notes/a.md" })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RemoteError);
    const err = refused as RemoteError;
    expect(err.reason).toBe("exists");
    expect(exportNeedsOverwrite(err.reason)).toBe(true);
    expect(
      exportedPath(
        (await client.send(row, "export.run", { path: "notes/a.md", overwrite: true })).data,
      ),
    ).toBe(first);
  });

  it("/mcp alone is terminal-only; /mcp reconnect's select is answered like any dialog", async () => {
    const alone = await client.send(row, "command.run", { line: "/mcp" }).catch((e: unknown) => e);
    expect((alone as RemoteError).reason).toBe("tui-only");
    await client.send(row, "command.run", { line: "/mcp reconnect" });
    const s = await state((x) => Boolean(x.prompt), "mcp select");
    expect(s.prompt).toMatchObject({ kind: "select", title: "MCP server", answerable: true });
    await client.send(row, "prompt.respond", { id: s.prompt!.id, value: s.prompt!.options![0] });
    expect(sb.events(pid).some((e) => e.action === "prompt.respond" && e.value === "github")).toBe(
      true,
    );
    await state((x) => x.prompt === null, "mcp closed");
  });

  it("rename names the session; branch and clear start a new one in the same pi", async () => {
    await client.send(row, "session.rename", { name: "Rate limiter" });
    await rowFor(svc, (r) => r.pid === pid && r.title === "Rate limiter", "renamed");
    const before = row.sessionId;
    await client.send(row, "session.branch", { name: "Try a leaky bucket" });
    const branched = await rowFor(svc, (r) => r.pid === pid && r.sessionId !== before, "branched");
    expect(fs.readFileSync(branched.sessionFile!, "utf8")).toContain("Add a token bucket");
    await client.send(branched, "session.clear", {});
    const cleared = await rowFor(
      svc,
      (r) => r.pid === pid && r.sessionId !== branched.sessionId,
      "cleared",
    );
    expect(cleared.messages).toBe(0);
  });
});

describe("an older forge build (FAKE_PI_AREAS=core)", () => {
  let sb: Sandbox;
  afterAll(() => sb?.cleanup());

  it("has no native-screen areas and answers their actions unknown-action", async () => {
    sb = createSandbox();
    sb.env.FAKE_PI_AREAS = "core";
    const svc = sb.service();
    const client = createRemoteClient({
      run: connectionRunner(sb.connection),
      agentDir: async () => (await svc.environment()).agentDir,
    });
    const started = await svc.startSession({ prompt: "hello", cwd: sb.home });
    const row = await rowFor(svc, (r) => r.pid === started.pid && r.state === "idle", "idle");
    const s = await until(async () => client.readState(row), "state");
    expect(s.footer).toBeTruthy();
    for (const key of ["tasks", "checkpoints", "pins", "side", "wake", "btw"] as const)
      expect(s[key]).toBeUndefined();
    for (const action of [
      "rewind.preview",
      "usage.refresh",
      "changelog.read",
      "export.run",
    ] as const)
      expect(await codeOf(client.send(row, action, {}))).toBe("unknown-action");
  }, 60_000);
});
