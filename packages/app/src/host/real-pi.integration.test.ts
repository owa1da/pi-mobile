// The host service against REAL pi + forge (not the fake): readiness before a paste, one user
// message per prompt, and draft refusal. Isolated: a temp HOME/agent dir (PI_CODING_AGENT_DIR),
// a private tmux socket, forge loaded from a copy ($PIM_E2E_FORGE or the remote-channel
// worktree, never the live ~/.pi/forge), PI_OFFLINE=1, no auth copied.
// The only model is a provider at 127.0.0.1:9 (connection refused) with retries off: a prompt is
// recorded in the session .jsonl, then fails before any model call. Costs nothing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PaneBusyError } from "./errors";
import type { PiHostService } from "./service";
import { createSandbox, type Sandbox } from "./test-support/sandbox";
import type { SessionRow } from "./types";

function findRealPi(): string | undefined {
  try {
    const found = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
    return found ? fs.realpathSync(found) : undefined;
  } catch {
    return undefined;
  }
}

const REAL_PI = findRealPi();
// Never the live pack (~/.pi/forge): the user's running pi sessions load it and other sessions
// edit it. Same source as scripts/e2e-emulator.mjs: $PIM_E2E_FORGE or the remote-channel worktree.
const LIVE_FORGE = path.join(os.homedir(), ".pi", "forge");
const FORGE =
  process.env.PIM_E2E_FORGE ||
  path.join(os.homedir(), "projects", "pi-mobile-work", "forge-remote");
if (path.resolve(FORGE) === path.resolve(LIVE_FORGE))
  throw new Error("real-pi integration test must not load the live forge at ~/.pi/forge");
const hasForge = fs.existsSync(path.join(FORGE, "extensions"));
if (!REAL_PI)
  console.warn("real-pi integration test skipped: `pi` is not installed on this machine");
else if (!hasForge) console.warn(`real-pi integration test skipped: forge is not at ${FORGE}`);

/** The user messages of a session file, as text. */
function userMessages(file: string | undefined): string[] {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      if (entry.type !== "message" || entry.message?.role !== "user") return [];
      const content = entry.message.content;
      if (typeof content === "string") return [content];
      if (!Array.isArray(content)) return [""];
      return [
        content
          .filter((b: { type?: string }) => b?.type === "text")
          .map((b: { text?: string }) => b.text ?? "")
          .join(""),
      ];
    });
}

async function rowFor(
  svc: PiHostService,
  pred: (r: SessionRow) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<SessionRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await svc.listSessions();
    const found = snap.rows.find(pred);
    if (found) return found;
    if (Date.now() > deadline)
      throw new Error(`no row: ${label}\n${JSON.stringify(snap.rows, null, 1)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Exactly `count` user messages, stable for a while (no duplicate arrives late). */
async function expectUserMessages(sb: Sandbox, file: string, count: number): Promise<string[]> {
  await sb.waitFor(() => userMessages(file).length >= count, 20_000, `${count} user messages`);
  await new Promise((r) => setTimeout(r, 1500));
  const messages = userMessages(file);
  expect(messages).toHaveLength(count);
  return messages;
}

const MULTI = "first line of the phone prompt\n  indented second line\n\nfourth line ✓ ünïcødé";
const BIG = Array.from(
  { length: 160 },
  (_, i) => `line ${i + 1}: the quick brown fox jumps over the lazy dog`,
).join("\n");

describe.skipIf(!REAL_PI || !hasForge)("host service against real pi + forge", () => {
  let sb: Sandbox;
  let svc: PiHostService;

  beforeAll(() => {
    sb = createSandbox({ withPi: false });
    fs.symlinkSync(REAL_PI!, path.join(sb.bin, "pi"));
    sb.env.PATH = `${sb.bin}:/usr/bin:/bin`;
    sb.env.PI_OFFLINE = "1";
    sb.env.PI_SKIP_VERSION_CHECK = "1";
    // Real pi writes node's compile cache into TMPDIR (the sandbox) as it exits: keep it out.
    sb.env.NODE_DISABLE_COMPILE_CACHE = "1";
    fs.writeFileSync(
      path.join(sb.agentDir, "settings.json"),
      JSON.stringify({
        packages: [FORGE],
        theme: "claude",
        tuiMode: "fullscreen",
        quietStartup: true,
        collapseChangelog: true,
        defaultProjectTrust: "always",
        lastChangelogVersion: "1.0.0",
        retry: { enabled: false },
        defaultProvider: "pimdead",
        defaultModel: "dead-1",
      }),
    );
    fs.writeFileSync(
      path.join(sb.agentDir, "models.json"),
      JSON.stringify({
        providers: {
          pimdead: {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "none",
            models: [{ id: "dead-1" }],
          },
        },
      }),
    );
    svc = sb.service({ readyTimeoutMs: 30_000 });
  });
  afterAll(async () => {
    if (!sb) return;
    sb.cleanup();
    // pi processes killed with the tmux server may still write on their way out: remove again.
    await new Promise((r) => setTimeout(r, 1500));
    fs.rmSync(sb.dir, { recursive: true, force: true });
  });

  it("starts with a >8 KiB multi-line prompt: pasted once pi is ready, one user message", async () => {
    const env = await svc.probe();
    expect(env.piCliPath).toBe(REAL_PI);
    const started = await svc.startSession({ prompt: BIG, cwd: sb.home });
    const row = await rowFor(svc, (r) => r.pid === started.pid && r.messages >= 1, "big row");
    const messages = await expectUserMessages(sb, row.sessionFile!, 1);
    expect(messages[0]).toBe(BIG);
  }, 120_000);

  it("sends a multi-line prompt right after registration: exactly one user message", async () => {
    const started = await svc.startSession({ cwd: sb.home });
    // The first listing that shows the record: no extra delay before the send.
    const row = await rowFor(svc, (r) => r.pid === started.pid, "registered");
    await svc.sendPrompt(row, MULTI);
    const fresh = await rowFor(svc, (r) => r.pid === started.pid && r.messages >= 1, "prompted");
    const messages = await expectUserMessages(sb, fresh.sessionFile!, 1);
    expect(messages[0]).toBe(MULTI);
  }, 120_000);

  it("resumes a closed session to send: one more user message, whole text", async () => {
    const started = await svc.startSession({ prompt: "before quit", cwd: sb.home });
    const live = await rowFor(svc, (r) => r.pid === started.pid && r.messages >= 1, "live");
    await expectUserMessages(sb, live.sessionFile!, 1);
    await svc.sendPrompt(live, "/quit");
    const closed = await rowFor(svc, (r) => r.sessionId === live.sessionId && !r.live, "closed");
    await svc.sendPrompt(closed, MULTI);
    const resumed = await rowFor(svc, (r) => r.sessionId === live.sessionId && r.live, "resumed");
    expect(resumed.pid).not.toBe(started.pid);
    const messages = await expectUserMessages(sb, live.sessionFile!, 2);
    expect(messages).toEqual(["before quit", MULTI]);
  }, 120_000);

  it("refuses to glue onto a draft in pi's editor, and sends once it is cleared", async () => {
    const started = await svc.startSession({ cwd: sb.home });
    const row = await rowFor(svc, (r) => r.pid === started.pid, "registered");
    await sb.waitFor(
      () => sb.tmux("capture-pane", "-p", "-t", started.pane).includes("─────"),
      15_000,
      "editor drawn",
    );
    sb.tmux("send-keys", "-t", started.pane, "-l", "desktop draft");
    await sb.waitFor(
      () => sb.tmux("capture-pane", "-p", "-t", started.pane).includes("desktop draft"),
      5000,
      "draft drawn",
    );
    await expect(svc.sendPrompt(row, "from the phone")).rejects.toSatisfy(
      (e: unknown) => e instanceof PaneBusyError && e.reason === "draft",
    );
    expect(sb.tmux("capture-pane", "-p", "-t", started.pane)).toContain("desktop draft");
    sb.tmux("send-keys", "-t", started.pane, "C-u");
    await sb.waitFor(
      () => !sb.tmux("capture-pane", "-p", "-t", started.pane).includes("desktop draft"),
      5000,
      "draft cleared",
    );
    await svc.sendPrompt(row, "from the phone");
    const fresh = await rowFor(svc, (r) => r.pid === started.pid && r.messages >= 1, "prompted");
    expect(await expectUserMessages(sb, fresh.sessionFile!, 1)).toEqual(["from the phone"]);
  }, 120_000);
});
