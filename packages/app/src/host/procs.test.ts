// Synthetic registry listings (shaped like commands.listingScript output) → dashboard rows.
import { describe, expect, it } from "vitest";

import { buildSnapshot, parseListing, parseSettings, sessionTitle } from "./procs";

const N = "PIMtest";
const HOST = "box";
const BOOT = "boot-1";
const NOW = 1_800_000_000; // s
const MS = NOW * 1000;

interface LiveOpts {
  pid: number;
  /** /proc start field as listed: matches procStart by default; "X" = dead. */
  st?: string;
  mtime?: number;
  fileExists?: "1" | "0" | "?";
  rec?: Record<string, unknown>;
}

function live(o: LiveOpts): string {
  const rec = {
    v: 1,
    pid: o.pid,
    procStart: "100",
    bootId: BOOT,
    host: HOST,
    startedAt: MS - 60_000,
    updatedAt: MS - 1000,
    cwd: "/w",
    tmux: { socket: "/tmp/s", pane: `%${o.pid}` },
    sessionId: `s${o.pid}`,
    sessionFile: `/f/${o.pid}.jsonl`,
    name: null,
    firstPrompt: `prompt ${o.pid}`,
    messages: 2,
    model: { provider: "p", id: "m" },
    state: "idle",
    stateSince: MS - 5000,
    waitingFor: null,
    activity: null,
    agents: { running: 0, workflows: 0, workflowName: null },
    lastRun: { outcome: "completed", error: null },
    lastText: "done",
    question: null,
    ...o.rec,
  };
  return `${N} L ${o.pid} ${o.st ?? rec.procStart} ${o.mtime ?? NOW - 10} ${o.fileExists ?? "1"}\n${JSON.stringify(rec)}\n`;
}

function ended(id: string, rec: Record<string, unknown> = {}): string {
  const r = {
    v: 1,
    host: HOST,
    pid: 9,
    sessionId: id,
    sessionFile: `/f/${id}.jsonl`,
    cwd: "/w",
    name: null,
    firstPrompt: `ended ${id}`,
    messages: 3,
    model: null,
    lastRun: { outcome: "completed", error: null },
    lastText: null,
    startedAt: MS - 7_200_000,
    endedAt: MS - 3_600_000,
    endReason: "quit",
    ...rec,
  };
  return `${N} E\n${JSON.stringify(r)}\n`;
}

function listing(
  body: string,
  opts: { host?: string; boot?: string; config?: string; complete?: boolean } = {},
): string {
  return (
    `${N} H ${opts.host ?? HOST} ${NOW}\n${N} B ${opts.boot ?? BOOT}\n${N} P 1\n` +
    body +
    (opts.config ? `${N} C\n${opts.config}\n` : "") +
    (opts.complete === false ? "" : `${N} Z\n`)
  );
}

const snap = (body: string, opts?: Parameters<typeof listing>[1]) =>
  buildSnapshot(parseListing(listing(body, opts), N));

describe("parseListing", () => {
  it("reads headers, records and completeness; ignores noise", () => {
    const l = parseListing(
      `motd noise\n${listing(live({ pid: 1 }) + ended("e1") + `${N} R\n{"sessionId":"x","host":"box"}\n`)}`,
      N,
    );
    expect(l).toMatchObject({
      host: HOST,
      nowSec: NOW,
      bootId: BOOT,
      hasProc: true,
      complete: true,
    });
    expect(l.live).toHaveLength(1);
    expect(l.live[0]).toMatchObject({ filePid: 1, procStart: "100", sessionFileExists: true });
    expect(l.ended).toHaveLength(1);
    expect(l.removed).toHaveLength(1);
    expect(parseListing(listing("", { complete: false }), N).complete).toBe(false);
  });
});

describe("sections and order", () => {
  it("groups like forge's sessions page", () => {
    const s = snap(
      live({
        pid: 1,
        rec: { state: "working", stateSince: MS - 1000, activity: "bash: npm test" },
      }) +
        live({ pid: 2, rec: { state: "working", stateSince: MS - 500 } }) +
        live({
          pid: 3,
          rec: {
            state: "waiting",
            waitingFor: { kind: "select", title: "Allow bash?" },
            stateSince: MS - 9000,
          },
        }) +
        live({ pid: 4, rec: { question: "Push it?", stateSince: MS - 100 } }) +
        live({ pid: 5, rec: { messages: 0, lastRun: null, stateSince: MS - 50 } }) +
        live({
          pid: 6,
          rec: { pendingQuestions: 2, pendingSince: MS - 20_000, state: "working" },
        }) +
        live({ pid: 7, rec: { stateSince: MS - 2000 } }) +
        live({
          pid: 8,
          rec: { wake: { due: MS + 60_000, since: MS - 30_000, missed: false, reason: "CI" } },
        }) +
        live({
          pid: 9,
          rec: { wake: { due: MS - 60_000, since: MS - 40_000, missed: true, reason: null } },
        }) +
        live({
          pid: 10,
          rec: { lastRun: { outcome: "error", error: "boom" }, stateSince: MS - 3000 },
        }) +
        ended("e1", { endedAt: MS - 1000 }),
    );
    const order = s.rows.map((r) => `${r.section}:${r.sessionId}`);
    expect(order).toEqual([
      // needs: asking first (newest first), then the rest (newest first)
      "needs:s4",
      "needs:s3",
      "needs:s6",
      "needs:s5",
      "needs:s9",
      // working: newest first
      "working:s2",
      "working:s1",
      "working:s8",
      // completed: live first, then closed
      "completed:s7",
      "completed:s10",
      "completed:e1",
    ]);
    expect(s.counts).toEqual({ needs: 5, working: 3, completed: 3 });
    const by = (id: string) => s.rows.find((r) => r.sessionId === id)!;
    expect(by("s3")).toMatchObject({ state: "waiting", asking: "Allow bash?" });
    expect(by("s4").asking).toBe("Push it?");
    expect(by("s6")).toMatchObject({ asking: "2 questions", since: MS - 20_000 });
    expect(by("s5").detail).toBe("send a prompt to start");
    expect(by("s1").detail).toBe("bash: npm test");
    expect(by("s2").detail).toBe("working…");
    expect(by("s8")).toMatchObject({
      since: MS - 30_000,
      detail: "waiting for a wake-up · CI",
      wake: { missed: false, reason: "CI" },
    });
    expect(by("s9").detail).toBe("wake-up missed");
    expect(by("s10").detail).toBe("error: boom");
    expect(by("s7").detail).toBe("done");
    expect(by("e1")).toMatchObject({
      live: false,
      state: "closed",
      endReason: "quit",
      since: MS - 1000,
    });
    expect(by("e1").pid).toBeUndefined();
    expect(by("s1").tmux).toEqual({ socket: "/tmp/s", pane: "%1" });
  });
});

describe("liveness and registry rules", () => {
  it("hides other hosts, turns dead processes into closed 'gone' rows", () => {
    const s = snap(
      live({ pid: 1, rec: { host: "other" } }) +
        live({ pid: 2, st: "X", mtime: NOW - 600 }) +
        live({ pid: 3, st: "999" }) + // reused pid: other start time
        live({ pid: 4, rec: { bootId: "boot-0" } }) + // rebooted
        live({ pid: 5, st: "X", rec: { messages: 0 } }) + // no conversation: dropped
        live({ pid: 6, st: "X", fileExists: "0" }) + // session file gone: dropped
        live({ pid: 7, st: "-" }) + // unreadable stat: alive
        live({ pid: 8, st: "K" }), // no /proc, kill -0 ok
    );
    const ids = s.rows.map((r) => `${r.sessionId}:${r.live ? "live" : r.endReason}`).sort();
    expect(ids).toEqual(["s2:gone", "s3:gone", "s4:gone", "s7:live", "s8:live"]);
    expect(s.rows.find((r) => r.sessionId === "s2")!.since).toBe((NOW - 600) * 1000);
  });

  it("ignores a record not named after its pid", () => {
    const body = live({ pid: 1 }).replace(`${N} L 1 `, `${N} L 2 `);
    expect(snap(body).rows).toHaveLength(0);
  });

  it("keeps one row per sessionId: newest updatedAt, then startedAt, then pid", () => {
    const s = snap(
      live({ pid: 1, rec: { sessionId: "dup", updatedAt: MS - 10 } }) +
        live({ pid: 2, rec: { sessionId: "dup", updatedAt: MS - 20 } }) +
        live({ pid: 3, rec: { sessionId: "tie", startedAt: 5 } }) +
        live({ pid: 4, rec: { sessionId: "tie", startedAt: 5 } }) +
        live({ pid: 5, rec: { sessionId: "tie", startedAt: 4 } }) +
        ended("dup"),
    );
    expect(s.rows.map((r) => `${r.sessionId}:${r.pid}`).sort()).toEqual(["dup:1", "tie:4"]);
  });

  it("drops ended rows that are removed, from another host, older than completedHours or beyond keepEnded", () => {
    let body =
      ended("keep") +
      ended("old", { endedAt: MS - 25 * 3_600_000 }) +
      ended("far", { host: "other" });
    body +=
      ended("gone-marked") + `${N} R\n{"sessionId":"gone-marked","host":"${HOST}","removedAt":1}\n`;
    body +=
      ended("other-marker") +
      `${N} R\n{"sessionId":"other-marker","host":"elsewhere","removedAt":1}\n`;
    expect(
      snap(body)
        .rows.map((r) => r.sessionId)
        .sort(),
    ).toEqual(["keep", "other-marker"]);
    const config = JSON.stringify({ forge: { sessions: { completedHours: 48, keepEnded: 1 } } });
    // 48 h keeps "old", but keepEnded 1 keeps only the newest.
    expect(
      snap(ended("keep", { endedAt: MS - 10 }) + ended("old", { endedAt: MS - 25 * 3_600_000 }), {
        config,
      }).rows.map((r) => r.sessionId),
    ).toEqual(["keep"]);
    expect(
      snap(ended("old", { endedAt: MS - 25 * 3_600_000 }), {
        config: JSON.stringify({ forge: { sessions: { completedHours: 48 } } }),
      }).rows,
    ).toHaveLength(1);
  });

  it("a dead record replaces the session's ended record", () => {
    const s = snap(
      ended("s2", { endReason: "quit", endedAt: MS - 5000 }) +
        live({ pid: 2, st: "X", mtime: NOW - 1 }),
    );
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ sessionId: "s2", endReason: "gone" });
  });

  it("parses settings defensively", () => {
    expect(parseSettings(undefined)).toEqual({ completedHours: 24, keepEnded: 50 });
    expect(parseSettings("{not json")).toEqual({ completedHours: 24, keepEnded: 50 });
    expect(
      parseSettings(JSON.stringify({ forge: { sessions: { completedHours: 0, keepEnded: -3 } } })),
    ).toEqual({ completedHours: 1, keepEnded: 0 });
  });
});

describe("titles and text", () => {
  it("follows forge's title rule and cleans control characters", () => {
    expect(sessionTitle({ name: "Named", firstPrompt: "x" })).toBe("Named");
    expect(sessionTitle({ name: null, firstPrompt: "\n\n**Fix** the `sleep 120` bug\nmore" })).toBe(
      "Fix the sleep 120 bug",
    );
    expect(sessionTitle({ name: null, firstPrompt: null })).toBe("new session");
    const s = snap(live({ pid: 1, rec: { name: "a\u001b[31mred\u001b[0m\u0007 b" } }));
    expect(s.rows[0]!.title).toBe("ared b");
  });

  it("tolerates broken records", () => {
    const body = `${N} L 5 100 1 1\n{"v":1,"pid":5\n${N} L 6 100 1 1\n{"v":0,"pid":6,"sessionId":"x"}\n${N} E\nnot json\n`;
    expect(snap(body).rows).toHaveLength(0);
  });
});
