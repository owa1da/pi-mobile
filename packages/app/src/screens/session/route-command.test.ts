import { describe, expect, it, vi } from "vitest";
import type { HostService, SessionRow } from "@/host/types";
import { RemoteError } from "@/remote/errors";
import { routeSessionCommand, slashIsCommand } from "./route-command";

const closed = { live: false, sessionId: "old", pid: 10 } as SessionRow;
function setup() {
  const ensureRemoteSession = vi.fn().mockResolvedValue({
    row: { ...closed, live: true, pid: 42 },
    state: { commands: [{ name: "model" }] },
  });
  const runCommand = vi.fn().mockResolvedValue({ ok: true });
  const service = { ensureRemoteSession, runCommand } as unknown as HostService;
  const open = vi.fn().mockResolvedValue(undefined);
  return { service, ensureRemoteSession, runCommand, open };
}
describe("completed session native routing", () => {
  it("waits for fresh validation before opening /model, never submits terminal picker text", async () => {
    const { service, ensureRemoteSession, runCommand, open } = setup();
    let ready!: () => void;
    ensureRemoteSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const pending = routeSessionCommand(service, closed, "/model", open);
    expect(ensureRemoteSession).toHaveBeenCalledExactlyOnceWith(closed, "/model");
    expect(open).not.toHaveBeenCalled();
    ready();
    await pending;
    expect(open).toHaveBeenCalledExactlyOnceWith("model", "");
    expect(runCommand).not.toHaveBeenCalled();
  });
  it.each(["model", "rename", "rewind", "cost", "thinking", "export"])(
    "routes /%s natively after resume",
    async (name) => {
      const { service, ensureRemoteSession, runCommand, open } = setup();
      await routeSessionCommand(service, closed, `/${name} arg`, open);
      expect(ensureRemoteSession).toHaveBeenCalledWith(closed, `/${name} arg`);
      expect(open).toHaveBeenCalledOnce();
      expect(runCommand).not.toHaveBeenCalled();
    },
  );
  it("a fresh list refusal never opens a stale cached native command", async () => {
    const { service, ensureRemoteSession, open } = setup();
    ensureRemoteSession.mockRejectedValue(new RemoteError("invalid"));
    await expect(routeSessionCommand(service, closed, "/model", open)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(open).not.toHaveBeenCalled();
  });
  it("typed commands work without any cached list", async () => {
    const { service, runCommand, open } = setup();
    await routeSessionCommand(service, closed, "/compact", open);
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(closed, "/compact");
    expect(open).not.toHaveBeenCalled();
  });
  it("reading saved /btw answers does not resume pi", async () => {
    const { service, ensureRemoteSession, runCommand, open } = setup();
    await routeSessionCommand(service, closed, "/btw", open);
    expect(open).toHaveBeenCalledExactlyOnceWith("btw", "");
    expect(ensureRemoteSession).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });
  it("a new /btw question does resume pi", async () => {
    const { service, ensureRemoteSession, open } = setup();
    await routeSessionCommand(service, closed, "/btw question?", open);
    expect(ensureRemoteSession).toHaveBeenCalledExactlyOnceWith(closed, "/btw question?");
    expect(open).toHaveBeenCalledExactlyOnceWith("btw", "question?");
  });
});

describe("slash line: command or message", () => {
  const known = [
    { name: "model", description: "" },
    { name: "compact", description: "" },
  ];
  it("sends path-shaped and skill lines as messages, never as commands", () => {
    expect(slashIsCommand("/tmp/example.ts please inspect this file", known)).toBe(false);
    expect(slashIsCommand("/tmp/example.ts please inspect this file", undefined)).toBe(false);
    expect(slashIsCommand("/skill:review this", known)).toBe(false);
  });
  it("runs native and known commands; unknown names are messages when the list is known", () => {
    expect(slashIsCommand("/model", undefined)).toBe(true);
    expect(slashIsCommand("/compact now", known)).toBe(true);
    expect(slashIsCommand("/nonsense words", known)).toBe(false);
  });
  it("validates an unknown name against fresh state when no list is known yet", () => {
    expect(slashIsCommand("/nonsense words", undefined)).toBe(true);
    expect(slashIsCommand("plain text", known)).toBe(false);
  });
});
