import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandUnavailableError, RemoteError } from "@/remote/errors";
import type { RemoteState } from "@/remote/types";
import type { SshConnection } from "@/ssh/types";
import { HostOutcomeUnknownError } from "./errors";
import { createHostService, type HostEnvironmentDetails } from "./service";
import type { SessionRow } from "./types";

const native = vi.hoisted(() => ({ readState: vi.fn(), send: vi.fn() }));
vi.mock("@/remote/for-service", () => ({ remoteFor: () => native }));
const row = { live: true, pid: 42, remote: 1, sessionId: "s" } as SessionRow;
const state: RemoteState = {
  v: 1,
  pid: 42,
  sessionId: "s",
  rev: 5,
  updatedAt: 1,
  view: "main",
  draft: false,
  input: { submit: true, maxBytes: 61440 },
  commands: [{ name: "compact", description: "Compact" }],
};
function service() {
  const exec = vi.fn();
  const connection = {
    exec,
    isConnected: () => true,
    close() {},
    onClose: () => () => {},
  } satisfies SshConnection;
  const svc = createHostService(connection, { readyTimeoutMs: 1 });
  vi.spyOn(svc, "probe").mockResolvedValue({
    agentDir: "/owned/agent",
    procsDir: "/owned/agent/forge/procs",
  } as HostEnvironmentDetails);
  vi.spyOn(svc, "listSessions").mockResolvedValue({ rows: [row] } as Awaited<
    ReturnType<typeof svc.listSessions>
  >);
  return { svc, exec };
}
beforeEach(() => {
  native.readState.mockReset().mockResolvedValue(state);
  native.send.mockReset().mockResolvedValue({ ok: true });
});
describe("native commands", () => {
  it("finds the new live PID, validates fresh commands and binds the action identity", async () => {
    const { svc, exec } = service();
    await svc.runCommand({ ...row, live: false, pid: 10 }, "/compact");
    expect(native.send).toHaveBeenCalledExactlyOnceWith(
      row,
      "command.run",
      { line: "/compact" },
      { rev: 5, sessionId: "s" },
    );
    expect(exec).not.toHaveBeenCalled();
  });
  it("concurrent command preparations join the same readiness read", async () => {
    const { svc } = service();
    const [a, b] = await Promise.all([
      svc.ensureRemoteSession(row, "/compact"),
      svc.ensureRemoteSession(row, "/compact"),
    ]);
    expect(a).toBe(b);
    expect(native.readState).toHaveBeenCalledTimes(1);
    expect(native.send).not.toHaveBeenCalled();
  });
  it("refuses the wrong PID even if a state claims the selected identity", async () => {
    native.readState.mockResolvedValue({ ...state, pid: 99 });
    const { svc } = service();
    await expect(svc.runCommand(row, "/compact")).rejects.toThrow();
    expect(native.send).not.toHaveBeenCalled();
  });
  it("a second definite stale refusal is not retried again", async () => {
    native.send.mockRejectedValue(new RemoteError("stale"));
    const { svc } = service();
    await expect(svc.runCommand(row, "/compact")).rejects.toMatchObject({ code: "stale" });
    expect(native.send).toHaveBeenCalledTimes(2);
    expect(native.readState).toHaveBeenCalledTimes(2);
  });
  it("refuses commands missing from the fresh list", async () => {
    const { svc } = service();
    await expect(svc.ensureRemoteSession(row, "/model")).rejects.toBeInstanceOf(
      CommandUnavailableError,
    );
    await expect(svc.ensureRemoteSession(row, "/model")).rejects.toMatchObject({ code: "invalid" });
    expect(native.send).not.toHaveBeenCalled();
  });
  it("refuses a mismatched state identity", async () => {
    native.readState.mockResolvedValue({ ...state, sessionId: "replacement" });
    const { svc, exec } = service();
    await expect(svc.runCommand(row, "/compact")).rejects.toThrow();
    expect(native.send).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
  it("requires native readiness and capability", async () => {
    native.readState.mockResolvedValue({ ...state, input: undefined });
    const { svc } = service();
    await expect(svc.ensureRemoteSession(row)).rejects.toThrow("voluntarily reload");
    expect(native.send).not.toHaveBeenCalled();
  });
  it("revalidates once after a definite stale refusal", async () => {
    native.send.mockRejectedValueOnce(new RemoteError("stale"));
    const { svc } = service();
    await svc.runCommand(row, "/compact");
    expect(native.send).toHaveBeenCalledTimes(2);
    expect(native.readState).toHaveBeenCalledTimes(2);
  });
  it("does not run a removed command after stale", async () => {
    native.send.mockRejectedValueOnce(new RemoteError("stale"));
    native.readState.mockResolvedValueOnce(state).mockResolvedValue({ ...state, commands: [] });
    const { svc } = service();
    await expect(svc.runCommand(row, "/compact")).rejects.toMatchObject({ code: "invalid" });
    expect(native.send).toHaveBeenCalledTimes(1);
  });
  it("does not reopen or retarget after stale identity change", async () => {
    native.send.mockRejectedValueOnce(new RemoteError("stale"));
    native.readState
      .mockResolvedValueOnce(state)
      .mockResolvedValue({ ...state, sessionId: "other" });
    const { svc, exec } = service();
    await expect(svc.runCommand(row, "/compact")).rejects.toThrow();
    expect(native.send).toHaveBeenCalledTimes(1);
    expect(exec).not.toHaveBeenCalled();
  });
  it.each(["transport", "timeout", "no-channel", "error"] as const)(
    "%s is an unknown outcome, never retried",
    async (code) => {
      native.send.mockRejectedValue(new RemoteError(code));
      const { svc, exec } = service();
      await expect(svc.runCommand(row, "/compact")).rejects.toBeInstanceOf(HostOutcomeUnknownError);
      expect(native.send).toHaveBeenCalledTimes(1);
      expect(exec).not.toHaveBeenCalled();
    },
  );
  it.each(["template", "skill", "tui-only"] as const)(
    "preserves %s refusal reasons for native routing",
    async (reason) => {
      const refusal = new RemoteError("refused", "Use its native route", {
        v: 1,
        nonce: "test",
        ok: false,
        code: "refused",
        message: null,
        data: { reason },
        at: 1,
      });
      native.send.mockRejectedValue(refusal);
      const { svc } = service();
      await expect(svc.runCommand(row, "/compact")).rejects.toBe(refusal);
    },
  );
});
