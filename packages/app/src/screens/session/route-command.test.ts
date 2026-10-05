import { describe, expect, it, vi } from "vitest";
import type { HostService, SessionRow } from "@/host/types";
import { RemoteError } from "@/remote/errors";
import { NATIVE_COMMANDS, nativeTarget } from "@/remote/menu";
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
describe("native command membership", () => {
  it.each(["toString", "constructor", "__proto__"])("never routes /%s natively", async (name) => {
    expect(nativeTarget(`/${name}`)).toBeUndefined();
    const { service, open, runCommand } = setup();
    await routeSessionCommand(service, closed, `/${name}`, open, vi.fn());
    expect(open).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(closed, `/${name}`);
  });
  it.each(Object.entries(NATIVE_COMMANDS))("routes own native /%s", (name, tool) => {
    expect(nativeTarget(`/${name} words`)).toEqual({ name, tool, arg: "words" });
  });
});

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
    const pending = routeSessionCommand(service, closed, "/model", open, vi.fn());
    expect(ensureRemoteSession).toHaveBeenCalledExactlyOnceWith(closed);
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
      await routeSessionCommand(service, closed, `/${name} arg`, open, vi.fn());
      expect(ensureRemoteSession).toHaveBeenCalledExactlyOnceWith(closed);
      expect(open).toHaveBeenCalledOnce();
      expect(runCommand).not.toHaveBeenCalled();
    },
  );
  it("a readiness refusal never opens a native screen", async () => {
    const { service, ensureRemoteSession, open } = setup();
    ensureRemoteSession.mockRejectedValue(new RemoteError("invalid"));
    await expect(
      routeSessionCommand(service, closed, "/model", open, vi.fn()),
    ).rejects.toMatchObject({
      code: "invalid",
    });
    expect(open).not.toHaveBeenCalled();
  });
  it("typed commands work without any cached list", async () => {
    const { service, runCommand, open } = setup();
    await routeSessionCommand(service, closed, "/compact", open, vi.fn());
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(closed, "/compact");
    expect(open).not.toHaveBeenCalled();
  });
  it("reading saved /btw answers does not resume pi", async () => {
    const { service, ensureRemoteSession, runCommand, open } = setup();
    await routeSessionCommand(service, closed, "/btw", open, vi.fn());
    expect(open).toHaveBeenCalledExactlyOnceWith("btw", "");
    expect(ensureRemoteSession).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });
  it("a new /btw question does resume pi", async () => {
    const { service, ensureRemoteSession, open } = setup();
    await routeSessionCommand(service, closed, "/btw question?", open, vi.fn());
    expect(ensureRemoteSession).toHaveBeenCalledExactlyOnceWith(closed);
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

describe("desktop /side replacement", () => {
  it.each(["typed", "menu"])("%s bare /side replaces the hidden side", async () => {
    const { service, ensureRemoteSession, open, runCommand } = setup();
    const session = {
      row: { ...closed, live: true, pid: 42 },
      state: { rev: 3, sessionId: "old", side: { id: "old-side", gen: 2, open: false } },
    };
    ensureRemoteSession.mockResolvedValue(session);
    const send = vi.fn().mockResolvedValue({ data: { id: "new-side", gen: 1 } });
    await routeSessionCommand(service, closed, "/side", open, send);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      session.row,
      "side.open",
      {},
      { rev: 3, sessionId: "old" },
    );
    expect(open).toHaveBeenCalledExactlyOnceWith("side", "", { sideId: "new-side", sideGen: "1" });
    expect(runCommand).not.toHaveBeenCalled();
  });
  it("/side words replaces and sends in the same action, never side.send or side.view", async () => {
    const { service, ensureRemoteSession, open } = setup();
    const session = {
      row: closed,
      state: { rev: 3, sessionId: "old", side: { id: "old-side", gen: 2, open: false } },
    };
    ensureRemoteSession.mockResolvedValue(session);
    const send = vi.fn().mockResolvedValue({ data: null });
    await routeSessionCommand(service, closed, "/side new words", open, send);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      closed,
      "side.open",
      { text: "new words" },
      { rev: 3, sessionId: "old" },
    );
    expect(open).toHaveBeenCalledExactlyOnceWith("side", "", {});
  });
  it("a failed replacement never opens the screen or retries", async () => {
    const { service, open } = setup();
    const send = vi.fn().mockRejectedValue(new RemoteError("stale"));
    await expect(routeSessionCommand(service, closed, "/side", open, send)).rejects.toMatchObject({
      code: "stale",
    });
    expect(open).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
});
