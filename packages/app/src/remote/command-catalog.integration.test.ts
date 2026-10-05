import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createSandbox } from "@/host/test-support/sandbox";
import { selectCatalogCommands, CATALOG_MAX_BYTES } from "./command-catalog";

describe("host catalog over SSH exec", () => {
  it("completed session discovers its menu with a fresh service, without resuming pi", async () => {
    const sb = createSandbox();
    try {
      const service = sb.service();
      const started = await service.startSession({ prompt: "catalog fixture", cwd: sb.home });
      await sb.waitForEvent(started.pid, (e) => e.kind === "start");
      await sb.waitForEvent(started.pid, (e) => e.kind === "submit");
      sb.tmux("send-keys", "-t", started.pane, "/quit", "Enter");
      await sb.waitForEvent(started.pid, (e) => e.kind === "quit");
      const fresh = sb.service();
      const row = (await fresh.listSessions()).rows.find((r) => !r.live)!;
      expect(row.cwd).toBe(sb.home);
      const catalog = await fresh.readCommandCatalog();
      expect(selectCatalogCommands(catalog, row.cwd)?.map((c) => c.name)).toContain("compact");
      expect((await fresh.listSessions()).rows.every((r) => !r.live)).toBe(true);
    } finally {
      sb.cleanup();
    }
  });
  it("absent, malformed, unknown and oversized files are ignored; agent paths are safely quoted", async () => {
    const sb = createSandbox();
    try {
      const dir = `${sb.agentDir}/quoted ' ; $d`;
      fs.mkdirSync(`${dir}/forge/procs`, { recursive: true });
      fs.mkdirSync(`${dir}/forge/remote`, { recursive: true });
      const service = sb.service({ agentDir: dir });
      const file = `${dir}/forge/remote/commands.json`;
      expect(await service.readCommandCatalog()).toBeUndefined();
      for (const text of ["{", '{"v":2}', " ".repeat(CATALOG_MAX_BYTES + 1)]) {
        fs.writeFileSync(file, text);
        expect(await service.readCommandCatalog()).toBeUndefined();
      }
      fs.writeFileSync(
        file,
        JSON.stringify({
          v: 1,
          updatedAt: 100,
          latest: {
            cwd: sb.home,
            at: 100,
            commands: [{ name: "host-added", description: "No app build" }],
          },
          byCwd: {},
        }),
      );
      expect((await service.readCommandCatalog())?.latest.commands[0].name).toBe("host-added");
    } finally {
      sb.cleanup();
    }
  });
});
