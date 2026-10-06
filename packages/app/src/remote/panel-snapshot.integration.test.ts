import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createSandbox } from "@/host/test-support/sandbox";
import { PANEL_MAX_BYTES } from "./panel-snapshot";

describe("display-only host snapshots over trusted SSH exec", () => {
  it.each(["usage", "changelog"] as const)(
    "reads bounded %s snapshots with safely quoted paths and no session",
    async (name) => {
      const sb = createSandbox();
      try {
        const agentDir = `${sb.agentDir}/quoted ' ; $d`;
        fs.mkdirSync(`${agentDir}/forge/procs`, { recursive: true });
        fs.mkdirSync(`${agentDir}/forge/remote`, { recursive: true });
        const service = sb.service({ agentDir });
        const file = `${agentDir}/forge/remote/${name}.json`;
        expect(await service.readPanelSnapshot(name)).toBeUndefined();
        for (const text of ["{", '{"v":2}', " ".repeat(PANEL_MAX_BYTES[name] + 1)]) {
          fs.writeFileSync(file, text);
          expect(await service.readPanelSnapshot(name)).toBeUndefined();
        }
        const snapshot = {
          v: 1,
          at: 1234,
          data: name === "usage" ? { accounts: [] } : { markdown: "## Release" },
        };
        fs.writeFileSync(file, JSON.stringify(snapshot));
        expect(await service.readPanelSnapshot(name)).toEqual(snapshot);
        expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(snapshot));
        expect((await service.listSessions()).rows).toEqual([]);
        expect(fs.readdirSync(`${agentDir}/forge/remote`)).toEqual([`${name}.json`]);
      } finally {
        sb.cleanup();
      }
    },
  );
});
