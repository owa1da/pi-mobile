import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteError } from "@/remote/errors";
import type { RemoteState } from "@/remote/types";
import type { SshConnection } from "@/ssh/types";
import { HostOutcomeUnknownError } from "./errors";
import { createHostService, type HostEnvironmentDetails } from "./service";
import type { SessionRow } from "./types";

const native = vi.hoisted(() => ({ readState: vi.fn(), send: vi.fn() }));
vi.mock("@/remote/for-service", () => ({ remoteFor: () => native }));
const row = {
  live: true,
  pid: 42,
  remote: 1,
  sessionId: "s",
  tmux: { pane: "%1", socket: "/owned/socket" },
} as SessionRow;
const state: RemoteState = {
  v: 1,
  pid: 42,
  sessionId: "s",
  rev: 5,
  updatedAt: 1,
  view: "main",
  draft: true,
  input: { submit: true, maxBytes: 61440 },
};
const env = {
  procsDir: "/owned/agent/forge/procs",
  agentDir: "/owned/agent",
} as HostEnvironmentDetails;
function service() {
  const exec = vi.fn();
  const connection = {
    exec,
    isConnected: () => true,
    close() {},
    onClose: () => () => {},
  } satisfies SshConnection;
  const svc = createHostService(connection, { readyTimeoutMs: 1 });
  vi.spyOn(svc, "probe").mockResolvedValue(env);
  vi.spyOn(svc, "listSessions").mockResolvedValue({ rows: [row] } as Awaited<
    ReturnType<typeof svc.listSessions>
  >);
  return { svc, exec };
}

beforeEach(() => {
  native.readState.mockReset().mockResolvedValue(state);
  native.send.mockReset().mockResolvedValue({ ok: true });
});

describe("native sendPrompt", () => {
  it.each([false, true])(
    "ignores draft=%s and submits only mobile text once, never a tmux command",
    async (draft) => {
      native.readState.mockResolvedValue({ ...state, draft });
      const { svc, exec } = service();
      const text = "mobile α\n  日本語";
      await svc.sendPrompt(row, text);
      expect(native.send).toHaveBeenCalledExactlyOnceWith(
        row,
        "input.submit",
        { text },
        { rev: 5, sessionId: "s" },
      );
      expect(exec).not.toHaveBeenCalled();
    },
  );
  it("a stale old row joins the current process and native channel", async () => {
    const { svc } = service();
    await svc.sendPrompt({ ...row, pid: 10, remote: undefined }, "mobile");
    expect(native.send.mock.calls[0][0]).toBe(row);
  });
  it("re-reads once after a definite stale refusal", async () => {
    native.send.mockRejectedValueOnce(new RemoteError("stale"));
    const { svc, exec } = service();
    await svc.sendPrompt(row, "mobile");
    expect(native.readState).toHaveBeenCalledTimes(2);
    expect(native.send).toHaveBeenCalledTimes(2);
    expect(exec).not.toHaveBeenCalled();
  });
  it("same-PID session switch during stale retry never retargets old text", async () => {
    native.readState
      .mockResolvedValueOnce(state)
      .mockResolvedValue({ ...state, sessionId: "new-session" });
    native.send.mockRejectedValueOnce(new RemoteError("stale", "session-mismatch"));
    const { svc, exec } = service();
    await expect(svc.sendPrompt(row, "old text")).rejects.toThrow();
    expect(native.send).toHaveBeenCalledExactlyOnceWith(
      row,
      "input.submit",
      { text: "old text" },
      { rev: 5, sessionId: "s" },
    );
    expect(exec).not.toHaveBeenCalled();
  });
  it("readiness polling cannot bind text to a replacement session", async () => {
    native.readState
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ ...state, sessionId: "new-session" });
    const { svc, exec } = service();
    vi.mocked(svc.listSessions)
      .mockResolvedValueOnce({ rows: [row] } as Awaited<ReturnType<typeof svc.listSessions>>)
      .mockResolvedValue({ rows: [{ ...row, sessionId: "new-session" }] } as Awaited<
        ReturnType<typeof svc.listSessions>
      >);
    await expect(svc.sendPrompt(row, "old text")).rejects.toThrow();
    expect(native.send).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
  it.each(["transport", "timeout", "no-channel", "error"] as const)(
    "%s never retries/reopens/pastes after a possible native submit",
    async (code) => {
      native.send.mockRejectedValue(new RemoteError(code));
      const { svc, exec } = service();
      await expect(svc.sendPrompt(row, "mobile")).rejects.toBeInstanceOf(HostOutcomeUnknownError);
      expect(native.send).toHaveBeenCalledTimes(1);
      expect(exec).not.toHaveBeenCalled();
    },
  );
  it("missing native capability reports voluntary update/reload, never pastes", async () => {
    native.readState.mockResolvedValue({ ...state, input: undefined });
    const { svc, exec } = service();
    await expect(svc.sendPrompt(row, "mobile")).rejects.toThrow("voluntarily reload");
    expect(native.send).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
  it("a channel-unavailable session never guesses rendered emptiness or pastes over a possible desktop draft", async () => {
    const { svc, exec } = service();
    vi.mocked(svc.listSessions).mockResolvedValue({
      rows: [{ ...row, remote: undefined }],
    } as Awaited<ReturnType<typeof svc.listSessions>>);
    await expect(svc.sendPrompt(row, "mobile")).rejects.toThrow("voluntarily reload");
    expect(native.readState).not.toHaveBeenCalled();
    expect(native.send).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses empty/oversized prompts before sending", async () => {
    const { svc, exec } = service();
    await expect(svc.sendPrompt(row, " \n\t")).rejects.toThrow("Nothing to send");
    await expect(svc.sendPrompt(row, "é".repeat(30721))).rejects.toMatchObject({
      code: "prompt-too-large",
    });
    expect(native.send).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
  it("dialog/main/side gate refusals do not trigger compatibility fallback", async () => {
    native.send.mockRejectedValue(new RemoteError("refused", "side owns the input"));
    const { svc, exec } = service();
    await expect(svc.sendPrompt(row, "mobile")).rejects.toThrow("side owns the input");
    expect(native.send).toHaveBeenCalledTimes(1);
    expect(exec).not.toHaveBeenCalled();
  });
});
