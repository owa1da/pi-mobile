import { describe, expect, it, vi } from "vitest";
import type { SessionRow, SessionsSnapshot } from "@/host/types";
import { startDashboardSession, takeDashboardCommand } from "./start-session";

const row = { sessionId: "new", live: true, pid: 42 } as SessionRow;
function service() {
  return {
    startSession: vi.fn().mockResolvedValue({ pid: 42 }),
    listSessions: vi.fn().mockResolvedValue({ rows: [row] } as SessionsSnapshot),
  };
}

describe("volatile dashboard command handoff", () => {
  it.each(["/compact", "/template words", "/skill:review words"])(
    "defers %s to the session dispatcher, never the starting prompt",
    async (line) => {
      const host = line;
      const fake = service();
      await startDashboardSession(fake, host, line);
      expect(fake.startSession).toHaveBeenCalledExactlyOnceWith({ prompt: "" });
      expect(takeDashboardCommand("other", "new")).toBeUndefined();
      expect(takeDashboardCommand(host, "other")).toBeUndefined();
      expect(takeDashboardCommand(host, "new")).toBe(line);
      expect(takeDashboardCommand(host, "new")).toBeUndefined();
    },
  );
  it.each(["ordinary text", "/tmp/file.ts inspect", "/"])(
    "keeps dashboard text %s unchanged",
    async (line) => {
      const fake = service();
      await startDashboardSession(fake, line, line);
      expect(fake.startSession).toHaveBeenCalledExactlyOnceWith({ prompt: line });
      expect(takeDashboardCommand(line, "new")).toBeUndefined();
    },
  );
  it("never replays an unconsumed action after an app reload", async () => {
    await startDashboardSession(service(), "reload", "/compact");
    vi.resetModules();
    const relaunched = await import("./start-session");
    expect(relaunched.takeDashboardCommand("reload", "new")).toBeUndefined();
    // Clear the previous runtime's map as well: this is not a persisted draft.
    expect(takeDashboardCommand("reload", "new")).toBe("/compact");
  });
});
