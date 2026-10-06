import { describe, expect, it, vi } from "vitest";
import type { SessionRow, SessionsSnapshot } from "@/host/types";
import * as sessions from "./sessions-store";

const row = { sessionId: "s", live: true, title: "Keep me" } as SessionRow;
const snapshot = (rows: SessionRow[]) => ({ rows }) as SessionsSnapshot;

describe("fresh session listings", () => {
  it("rejects out-of-order listing responses", async () => {
    const store = sessions.createSessionsStore();
    let old!: (value: SessionsSnapshot) => void;
    const listSessions = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            old = resolve;
          }),
      )
      .mockResolvedValueOnce(snapshot([row]));
    const refresh = sessions.createSessionsRefresher({
      store,
      getService: () => ({ listSessions }),
      reportFailure: vi.fn(),
    });
    const first = refresh("h");
    await refresh("h");
    old(snapshot([]));
    await first;
    expect(sessions.findRow(store.getState().entries.h, "s")).toBe(row);
  });
  it("does not report an obsolete failed listing over a fresh success", async () => {
    const store = sessions.createSessionsStore();
    let fail!: (error: Error) => void;
    const reportFailure = vi.fn();
    const listSessions = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValueOnce(snapshot([row]));
    const refresh = sessions.createSessionsRefresher({
      store,
      getService: () => ({ listSessions }),
      reportFailure,
    });
    const first = refresh("h");
    await refresh("h");
    fail(new Error("old failure"));
    await first;
    expect(reportFailure).not.toHaveBeenCalled();
    expect(store.getState().entries.h.error).toBeUndefined();
  });
});

describe("display-only session settling", () => {
  it("row → missing → row never shows gone; only three fresh successful misses do", () => {
    expect(sessions.settleSessionPresence).toBeTypeOf("function");
    const store = sessions.createSessionsStore();
    let presence: sessions.SessionPresence = { misses: 0 };
    const apply = (rows: SessionRow[], pending = false) => {
      store.getState().setSnapshot("h", snapshot(rows), 0);
      presence = sessions.settleSessionPresence(presence, store.getState().entries.h, "s");
      return sessions.sessionIsGone(presence, pending);
    };
    expect(apply([row])).toBe(false);
    expect(apply([])).toBe(false);
    expect(presence.row).toBe(row);
    expect(apply([row])).toBe(false);
    expect(apply([])).toBe(false);
    const same = sessions.settleSessionPresence(presence, store.getState().entries.h, "s");
    expect(same).toBe(presence); // rerender is not another listing
    store.getState().setError("h", "offline");
    expect(sessions.settleSessionPresence(presence, store.getState().entries.h, "s")).toBe(
      presence,
    );
    expect(apply([])).toBe(false);
    expect(apply([])).toBe(true);
    expect(sessions.findRow(store.getState().entries.h, "s")).toBeUndefined();
  });
  it("prunes 1000 gone rows while a watched session still reaches three misses", () => {
    const store = sessions.createSessionsStore();
    store.getState().setSnapshot(
      "h",
      snapshot(
        Array.from({ length: 1000 }, (_, i) => ({
          ...row,
          sessionId: `s${i}`,
        })),
      ),
      0,
    );
    let watched = sessions.settleSessionPresence({ misses: 0 }, store.getState().entries.h, "s0");
    for (let i = 0; i < 10; i++) {
      store.getState().setSnapshot("h", snapshot([]), 0);
      if (i < 2) {
        watched = sessions.settleSessionPresence(watched, store.getState().entries.h, "s0");
        expect(sessions.sessionIsGone(watched, false)).toBe(false);
      }
    }
    watched = sessions.settleSessionPresence(watched, store.getState().entries.h, "s0");
    expect(sessions.sessionIsGone(watched, false)).toBe(true);
    expect(watched.row?.sessionId).toBe("s0");
    expect(sessions.sessionIsGone(watched, true)).toBe(false);
    expect(Object.keys(store.getState().entries.h.presence ?? {})).toHaveLength(0);
    store.getState().setSnapshot("h", snapshot([row]), 0);
    expect(sessions.settleSessionPresence(watched, store.getState().entries.h, "s").misses).toBe(0);
  });
  it.each(["send", "resume", "side navigation"])("never shows gone during pending %s", () => {
    expect(sessions.sessionIsGone).toBeTypeOf("function");
    expect(sessions.sessionIsGone({ row, misses: 3 }, true)).toBe(false);
    expect(sessions.sessionIsGone({ row, misses: 3 }, false)).toBe(true);
  });
});
