// The remote client against REAL pi loading the forge pack from the remote-channel worktree
// (~/projects/pi-mobile-work/forge-remote, never the live ~/.pi/forge). Isolated: temp HOME/agent
// dir (PI_CODING_AGENT_DIR), private tmux socket, PI_OFFLINE=1, no auth copied, a dead local
// model. A test-only rig extension (`/pimrig`) opens a select, a confirm and an input, and logs
// what each returned. Skipped when pi or the worktree is missing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PiHostService } from "@/host/service";
import { createSandbox, type Sandbox } from "@/host/test-support/sandbox";
import type { SessionRow } from "@/host/types";
import { connectionRunner, createRemoteClient, type RemoteClient } from "./client";
import { RemoteError } from "./errors";
import type { RemoteState } from "./types";

function findRealPi(): string | undefined {
  try {
    const found = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
    return found ? fs.realpathSync(found) : undefined;
  } catch {
    return undefined;
  }
}

const REAL_PI = findRealPi();
const FORGE =
  process.env.PIM_FORGE_WORKTREE ??
  path.join(os.homedir(), "projects", "pi-mobile-work", "forge-remote");
const hasForge = fs.existsSync(path.join(FORGE, "extensions", "remote.ts"));
if (!REAL_PI) console.warn("real-forge test skipped: `pi` is not installed on this machine");
else if (!hasForge) console.warn(`real-forge test skipped: no remote-channel forge at ${FORGE}`);

const RIG = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default function (pi) {
  const log = (line) =>
    appendFileSync(join(process.env.PI_CODING_AGENT_DIR, "pimrig.log"), line + "\\n");
  pi.registerCommand("pimrig", {
    description: "pi-mobile test rig: a select, a confirm and an input",
    handler: async (_args, ctx) => {
      const color = await ctx.ui.select("RIG pick a color", ["red", "green", "blue"]);
      log("picked=" + String(color));
      const sure = await ctx.ui.confirm("RIG are you sure?", "The rig asks once.");
      log("confirm=" + String(sure));
      const name = await ctx.ui.input("RIG name it", "a name");
      log("input=" + String(name));
    },
  });
}
`;

async function rowFor(
  svc: PiHostService,
  pred: (r: SessionRow) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<SessionRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await svc.listSessions();
    const found = snap.rows.find(pred);
    if (found) return found;
    if (Date.now() > deadline)
      throw new Error(`no row: ${label}\n${JSON.stringify(snap.rows, null, 1)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function stateWhere(
  client: RemoteClient,
  row: SessionRow,
  pred: (s: RemoteState) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<RemoteState> {
  const deadline = Date.now() + timeoutMs;
  let last: RemoteState | undefined;
  for (;;) {
    last = await client.readState(row);
    if (last && pred(last)) return last;
    if (Date.now() > deadline)
      throw new Error(`state never matched: ${label}\n${JSON.stringify(last, null, 1)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const isRig = (c: { name: string }) => c.name === "pimrig";
const hasRig = (s: RemoteState) => (s.commands ?? []).some(isRig);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof RemoteError) return error.code;
    throw error;
  }
}

describe.skipIf(!REAL_PI || !hasForge)("remote channel against real pi + forge worktree", () => {
  let sb: Sandbox;
  let svc: PiHostService;
  let client: RemoteClient;
  let row: SessionRow;
  let pane: string;
  const rigLog = () => {
    try {
      return fs.readFileSync(path.join(sb.agentDir, "pimrig.log"), "utf8");
    } catch {
      return "";
    }
  };

  beforeAll(async () => {
    sb = createSandbox({ withPi: false });
    fs.symlinkSync(REAL_PI!, path.join(sb.bin, "pi"));
    sb.env.PATH = `${sb.bin}:/usr/bin:/bin`;
    sb.env.PI_OFFLINE = "1";
    sb.env.PI_SKIP_VERSION_CHECK = "1";
    sb.env.NODE_DISABLE_COMPILE_CACHE = "1";
    const rig = path.join(sb.dir, "pimrig.ts");
    fs.writeFileSync(rig, RIG);
    fs.writeFileSync(
      path.join(sb.agentDir, "settings.json"),
      JSON.stringify({
        packages: [FORGE],
        extensions: [rig],
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
    client = createRemoteClient({
      run: connectionRunner(sb.connection),
      agentDir: async () => (await svc.environment()).agentDir,
    });
    const started = await svc.startSession({ cwd: sb.home });
    pane = started.pane;
    row = await rowFor(svc, (r) => r.pid === started.pid && r.remote === 1, "remote: 1 row");
  }, 90_000);

  afterAll(async () => {
    if (!sb) return;
    sb.cleanup();
    await new Promise((r) => setTimeout(r, 1500));
    fs.rmSync(sb.dir, { recursive: true, force: true });
  });

  it("publishes state with the rig in the / menu and no dialog", async () => {
    const state = await stateWhere(client, row, hasRig, "pimrig listed");
    expect(state.pid).toBe(row.pid);
    expect(state.prompt).toBeNull();
    expect(Array.isArray(state.questions)).toBe(true);
    expect(state.view).toBe("main");
  }, 60_000);

  it("runs /pimrig, answers its select and input from the app; the desktop wins the confirm", async () => {
    await client.send(row, "command.run", { line: "/pimrig" });
    const select = await stateWhere(client, row, (s) => s.prompt?.kind === "select", "select");
    expect(select.prompt).toMatchObject({
      title: "RIG pick a color",
      options: ["red", "green", "blue"],
      answerable: true,
    });
    expect(
      await codeOf(client.send(row, "prompt.respond", { id: select.prompt!.id, value: "pink" })),
    ).toBe("invalid");
    await client.send(row, "prompt.respond", { id: select.prompt!.id, value: "green" });
    await sb.waitFor(() => rigLog().includes("picked=green"), 10_000, "rig picked green");

    const confirm = await stateWhere(client, row, (s) => s.prompt?.kind === "confirm", "confirm");
    expect(confirm.prompt!.title).toContain("RIG are you sure?");
    // The desktop answers first (Enter on the highlighted Yes); the app's answer is then stale.
    sb.tmux("send-keys", "-t", pane, "Enter");
    await sb.waitFor(() => rigLog().includes("confirm=true"), 10_000, "desktop confirm");
    expect(
      await codeOf(client.send(row, "prompt.respond", { id: confirm.prompt!.id, value: "No" })),
    ).toBe("stale");

    const input = await stateWhere(client, row, (s) => s.prompt?.kind === "input", "input");
    await client.send(row, "prompt.respond", { id: input.prompt!.id, value: "from the phone" });
    await sb.waitFor(() => rigLog().includes("input=from the phone"), 10_000, "rig input");
    await stateWhere(client, row, (s) => s.prompt === null, "dialog closed");
    expect(rigLog().trim().split("\n")).toEqual([
      "picked=green",
      "confirm=true",
      "input=from the phone",
    ]);
  }, 90_000);

  it("refuses TUI-only commands, names unknown actions, expires old actions", async () => {
    const refused = await client.send(row, "command.run", { line: "/settings" }).catch((e) => e);
    expect(refused).toBeInstanceOf(RemoteError);
    expect((refused as RemoteError).code).toBe("refused");
    expect((refused as RemoteError).detail).toMatch(/opens a terminal view/);
    expect(await codeOf(client.send(row, "no.such" as never, {} as never))).toBe("unknown-action");
    const old = createRemoteClient({
      run: connectionRunner(sb.connection),
      agentDir: async () => (await svc.environment()).agentDir,
      now: () => Date.now() - 120_000,
    });
    expect(await codeOf(old.send(row, "command.run", { line: "/pimrig" }))).toBe("expired");
  }, 60_000);
});
