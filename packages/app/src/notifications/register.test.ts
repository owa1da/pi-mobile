import { describe, expect, it, vi } from "vitest";
import { registrationScript, unregisterScript, registerDevice, unregisterDevice } from "./register";

describe("push device SSH registration", () => {
  it("quotes agentDir, validates filenames, and keeps JSON only on stdin", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0 });
    const service = {
      environment: async () => ({ agentDir: "/tmp/it's $(touch bad)" }),
      connection: { exec },
    };
    await registerDevice(service, "installation-1", "host-2", "secret-token", 100);
    const [command, options] = exec.mock.calls[0]!;
    expect(command).not.toContain("secret-token");
    expect(options.stdin).toBe(
      JSON.stringify({
        v: 1,
        transport: "expo",
        token: "secret-token",
        hostId: "host-2",
        expiresAt: 100 + 30 * 86400000,
      }),
    );
    const script = Buffer.from(
      command.match(/printf %s ([A-Za-z0-9+/=]+)/)![1],
      "base64",
    ).toString();
    expect(script).toContain("umask 077");
    expect(script).toContain("'\\''");
    expect(options.timeoutMs).toBe(3000);
    expect(() => registrationScript("/a", "../escape", "h")).toThrow();
    expect(() => unregisterScript("/a", "i", "h/x")).toThrow();
  });
  it("uses private directories, exclusive temp creation, permissions and atomic rename", () => {
    const script = registrationScript("/a'b", "i", "h");
    expect(script).toContain("mkdir -p -m 700");
    expect(script).toContain("mktemp");
    expect(script).toContain("chmod 600");
    expect(script).toContain("mv -f");
    expect(script).toContain("trap");
  });
  it("unregisters through bounded SSH without stdin", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0 });
    await unregisterDevice(
      { environment: async () => ({ agentDir: "/a" }), connection: { exec } },
      "i",
      "h",
    );
    const script = Buffer.from(
      exec.mock.calls[0]![0].match(/printf %s ([A-Za-z0-9+/=]+)/)![1],
      "base64",
    ).toString();
    expect(script).toContain("rm -f");
    expect(exec.mock.calls[0]![1]).toEqual({ timeoutMs: 3000 });
  });
});
