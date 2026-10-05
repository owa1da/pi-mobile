import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wrapForAnyShell } from "@/host/commands";
import { registrationScript, unregisterScript } from "./register";

describe("push registration POSIX shell", () => {
  it("writes exact stdin atomically with 0700/0600, safely quotes paths, and unregisters", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-push-"));
    try {
      const agentDir = join(root, "agent' $(touch INJECTED)");
      const directory = join(agentDir, "forge/push/devices");
      const file = join(directory, "installation.host.json");
      const payload = JSON.stringify({
        v: 1,
        transport: "expo",
        token: "token' $(touch TOKEN)",
        hostId: "host",
        expiresAt: 123,
      });
      const run = (script: string, input?: string) =>
        execFileSync("sh", ["-c", wrapForAnyShell(script)], { cwd: root, input, encoding: "utf8" });
      run(registrationScript(agentDir, "installation", "host"), payload);
      expect(readFileSync(file, "utf8")).toBe(payload);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(existsSync(join(root, "INJECTED"))).toBe(false);
      expect(existsSync(join(root, "TOKEN"))).toBe(false);
      run(registrationScript(agentDir, "installation", "host"), "replacement");
      expect(readFileSync(file, "utf8")).toBe("replacement");
      expect(readdirSync(directory)).toEqual(["installation.host.json"]);
      run(unregisterScript(agentDir, "installation", "host"));
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
