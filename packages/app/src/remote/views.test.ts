import { describe, expect, it } from "vitest";
import { btwEntriesScript, parseEntryLines } from "./session-file";
import {
  agoText,
  btwHistory,
  changelogMarkdown,
  checkpointChange,
  checkpointsNewestFirst,
  costRows,
  costText,
  diffLines,
  exportedPath,
  exportNeedsOverwrite,
  footerParts,
  footerRef,
  modelGroups,
  parseCheckpointDiff,
  parseModels,
  parseRewindPreview,
  parseUsage,
  rewindLine,
  rewindPrompts,
  sessionName,
  syncText,
  tailText,
  taskRows,
  wakeArgs,
  wakeWhen,
  windowText,
} from "./views";
import type { RemoteFooter, RemoteTask } from "./types";
import type { ModelGroup } from "./views";

const groupRefs = (groups: ModelGroup[]) => groups.map((g) => [g.key, g.models.map((m) => m.ref)]);

const footer = (over: Partial<RemoteFooter> = {}): RemoteFooter => ({
  model: { provider: "anthropic", id: "claude-opus-5-5", name: "Opus 5.5", thinking: "high" },
  contextPercent: 12,
  contextTokens: 24000,
  contextWindow: 200000,
  cost: 0.42,
  ...over,
});

describe("/rewind", () => {
  it("words the counts as the CLI does", () => {
    expect(rewindLine({ files: 4, added: 21, removed: 2, text: null })).toBe(
      "4 files changed +21 -2",
    );
    expect(rewindLine({ files: 1, added: 3, removed: 0, text: null })).toBe("1 file changed +3");
    expect(rewindLine({ files: 0, added: 0, removed: 0, text: null })).toBe("No code changes");
    expect(rewindLine({ files: 0, added: 0, removed: 0, text: "! m.txt left alone" })).toBe(
      "! m.txt left alone",
    );
  });

  it("reads preview data defensively", () => {
    expect(parseRewindPreview({ files: 2, added: 5, removed: 1 })).toEqual({
      files: 2,
      added: 5,
      removed: 1,
      text: null,
    });
    expect(parseRewindPreview({ files: ["a", "b"] })?.files).toBe(2);
    expect(parseRewindPreview({ text: "No code changes" })?.text).toBe("No code changes");
    expect(parseRewindPreview(null)).toBeNull();
    expect(parseRewindPreview({})).toBeNull();
  });

  it("lists the branch's prompts oldest first, without pending echoes", () => {
    expect(
      rewindPrompts([
        { kind: "user", key: "e1", text: "first" },
        { kind: "assistant", key: "e2", text: "reply" },
        { kind: "user", key: "e3", text: "  " },
        { kind: "user", key: "e4", text: "second" },
        { kind: "user", key: "p1", text: "pending", pending: true },
      ]),
    ).toEqual([
      { entryId: "e1", text: "first" },
      { entryId: "e4", text: "second" },
    ]);
  });
});

describe("/diff and /restore", () => {
  it("tags patch lines for their tint and caps long patches", () => {
    const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n";
    expect(diffLines(patch).lines.map((l) => l.kind)).toEqual([
      "file",
      "file",
      "file",
      "hunk",
      "context",
      "del",
      "add",
    ]);
    const long = Array.from({ length: 10 }, (_, i) => `+${i}`).join("\n");
    expect(diffLines(long, 4)).toMatchObject({ cut: true });
    expect(diffLines(long, 4).lines).toHaveLength(4);
  });

  it("reads checkpoint.diff data and orders checkpoints newest first", () => {
    expect(parseCheckpointDiff({ patch: "x", truncated: true })).toEqual({
      patch: "x",
      truncated: true,
    });
    expect(parseCheckpointDiff({ patch: 1 })).toBeNull();
    const cp = (n: number) => ({
      n,
      entryId: `e${n}`,
      label: "",
      at: 0,
      files: n,
      added: 1,
      removed: 0,
    });
    expect(checkpointsNewestFirst([cp(1), cp(3), cp(2)]).map((c) => c.n)).toEqual([3, 2, 1]);
    expect(checkpointChange(cp(2))).toBe("2 files changed +1");
    expect(agoText(1000, 42_000)).toBe("41s ago");
    expect(agoText(0, 5 * 60_000)).toBe("5m ago");
    expect(agoText(0, 3 * 3600_000)).toBe("3h ago");
    expect(agoText(0, 2 * 86_400_000)).toBe("2d ago");
  });
});

describe("/tasks", () => {
  const task = (key: string, status: string): RemoteTask => ({
    owner: "main",
    key,
    kind: "shell",
    name: key,
    status,
    detail: null,
    canStop: false,
    canResume: false,
    sessionFile: null,
    logPath: null,
    runDir: null,
  });

  it("puts running tasks first and keeps forge's order", () => {
    expect(
      taskRows([
        task("a", "done"),
        task("b", "running"),
        task("c", "failed"),
        task("d", "running"),
      ]).map((t) => t.key),
    ).toEqual(["b", "d", "a", "c"]);
    expect(tailText({ text: "line\u001b[31m red\n" })).toBe("line red\n");
    expect(tailText(null)).toBe("");
  });
});

describe("/model", () => {
  const available = parseModels({
    available: [
      { ref: "anthropic/opus", name: "Opus 5.5" },
      { ref: "openai/gpt", name: "GPT 6" },
      { ref: "anthropic/opus", name: "dup" },
      { ref: "google/gem" },
      { name: "no ref" },
    ],
  });

  it("parses unique refs, falling back to the ref for the name", () => {
    expect(available.map((m) => m.ref)).toEqual(["anthropic/opus", "openai/gpt", "google/gem"]);
    expect(available[2].name).toBe("google/gem");
  });

  it("groups pinned, then recent (never a pin), then all; drops empty groups", () => {
    const groups = modelGroups(available, {
      pinned: ["openai/gpt", "gone/model"],
      recent: ["openai/gpt", "google/gem"],
    });
    expect(groupRefs(groups)).toEqual([
      ["pinned", ["openai/gpt", "gone/model"]],
      ["recent", ["google/gem"]],
      ["all", ["anthropic/opus"]],
    ]);
    expect(modelGroups(available, undefined).map((g) => g.key)).toEqual(["all"]);
  });

  it("knows the footer's model ref, never 'unknown'", () => {
    expect(footerRef(footer())).toBe("anthropic/claude-opus-5-5");
    expect(
      footerRef(footer({ model: { provider: "", id: "unknown", name: "", thinking: "" } })),
    ).toBeNull();
  });
});

describe("footer", () => {
  it("shows exactly the status line's items forge publishes", () => {
    expect(footerParts(footer())).toEqual(["Opus 5.5", "high", "ctx 12%/200k", "$0.420"]);
    expect(footerParts(footer({ cost: null, contextWindow: null }))).toEqual([
      "Opus 5.5",
      "high",
      "ctx 12%",
    ]);
    expect(
      footerParts(footer({ model: { provider: "x", id: "unknown", name: "", thinking: "high" } })),
    ).toEqual(["ctx 12%/200k", "$0.420"]);
    expect(footerParts(null)).toEqual([]);
    expect(windowText(1_000_000)).toBe("1.0M");
    expect(windowText(272_000)).toBe("272k");
    expect(costText(1.234)).toBe("$1.23");
    expect(costText(12.5)).toBe("$13");
  });
});

describe("/usage and /cost", () => {
  it("reads accounts and meters, clamping percent left", () => {
    const accounts = parseUsage({
      accounts: [
        {
          title: "Claude · Max 20x",
          meters: [
            { label: "5-hour", left: 93.7, detail: "Resets in 5h 30m" },
            { label: "Weekly", left: 140 },
            { label: "Credits", value: "$12.34 left" },
            { nope: 1 },
          ],
        },
        { note: "untitled" },
      ],
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].meters.map((m) => m.left)).toEqual([93, 100, null]);
    expect(accounts[0].meters[2].value).toBe("$12.34 left");
    expect(parseUsage(null)).toEqual([]);
  });

  it("shows cost.read rows, its text, or the footer's cost", () => {
    expect(costRows({ rows: [{ label: "Total", value: "$0.012" }] }, null)).toEqual([
      { label: "Total", value: "$0.012" },
    ]);
    expect(costRows({ text: "Session Info\nMessages: 12\nTotal: $0.4" }, null)).toEqual([
      { label: "Messages", value: "12" },
      { label: "Total", value: "$0.4" },
    ]);
    expect(costRows(null, footer())).toEqual([{ label: "Total", value: "$0.420" }]);
    expect(costRows(null, footer({ cost: null }))).toEqual([]);
  });
});

describe("/pause", () => {
  const now = new Date(2026, 9, 2, 14, 0, 0);

  it("takes 1–1440 minutes", () => {
    expect(wakeArgs("in", "30", " CI ", now)).toEqual({ ok: true, args: { in: 30, reason: "CI" } });
    expect(wakeArgs("in", "0", "", now)).toEqual({ ok: false, error: "minutes" });
    expect(wakeArgs("in", "1441", "", now)).toEqual({ ok: false, error: "minutes" });
    expect(wakeArgs("in", "1.5", "", now)).toEqual({ ok: false, error: "minutes" });
  });

  it("takes a clock time, today if still ahead, else tomorrow", () => {
    const later = wakeArgs("at", "14:30", "", now);
    expect(later).toEqual({ ok: true, args: { at: new Date(2026, 9, 2, 14, 30).getTime() } });
    const pm = wakeArgs("at", "2:30pm", "", now);
    expect(pm.ok && "at" in pm.args && pm.args.at).toBe(new Date(2026, 9, 2, 14, 30).getTime());
    const morning = wakeArgs("at", "9.05", "", now);
    expect(morning.ok && "at" in morning.args && morning.args.at).toBe(
      new Date(2026, 9, 3, 9, 5).getTime(),
    );
    expect(wakeArgs("at", "25:00", "", now)).toEqual({ ok: false, error: "time" });
    expect(wakeArgs("at", "13:00pm", "", now)).toEqual({ ok: false, error: "time" });
    expect(wakeArgs("at", "soon", "", now)).toEqual({ ok: false, error: "time" });
  });

  it("words the pending wake-up", () => {
    const due = new Date(2026, 9, 2, 14, 32).getTime();
    expect(wakeWhen(due, new Date(2026, 9, 2, 14, 9).getTime())).toEqual({
      at: "2:32 PM",
      left: "23m",
    });
    expect(wakeWhen(due, new Date(2026, 9, 2, 12, 2).getTime()).left).toBe("2h 30m");
  });
});

describe("smaller sheets", () => {
  it("reads export, sync and changelog data", () => {
    expect(exportedPath({ path: "/w/notes.md" })).toBe("/w/notes.md");
    expect(exportedPath(null)).toBeNull();
    expect(exportNeedsOverwrite(null, { exists: true })).toBe(true);
    expect(exportNeedsOverwrite("Not exported: a.md exists · use another name", null)).toBe(true);
    expect(exportNeedsOverwrite("Not exported: a.md is a symbolic link", null)).toBe(false);
    expect(syncText({ text: "ok\nclean" })).toBe("ok\nclean");
    expect(syncText({ lines: ["a", 1, "b"] })).toBe("a\nb");
    expect(changelogMarkdown({ markdown: "# 1.0" })).toBe("# 1.0");
    expect(changelogMarkdown({})).toBe("");
    expect(sessionName("  Fix\nthe login  ")).toBe("Fix the login");
  });
});

describe("/btw", () => {
  it("keeps the history after the last clear, newest 20", () => {
    const btw = (q: string) => ({
      type: "custom",
      customType: "forge-btw",
      data: { question: q, answer: `a ${q}` },
    });
    const entries = [
      btw("old"),
      { type: "custom", customType: "forge-btw-clear", data: {} },
      btw("q1"),
      { type: "custom", customType: "forge-btw", data: { question: "q2", answer: "a", note: "n" } },
      { type: "custom", customType: "other", data: {} },
      { type: "message" },
    ];
    expect(btwHistory(entries)).toEqual([
      { question: "q1", answer: "a q1" },
      { question: "q2", answer: "a", note: "n" },
    ]);
    expect(btwHistory(Array.from({ length: 25 }, (_, i) => btw(`q${i}`)))).toHaveLength(20);
  });

  it("greps only its entries from a quoted path and parses whole lines", () => {
    const script = btwEntriesScript("/w/it's here.jsonl", "pimtag1234");
    expect(script).toContain(`'/w/it'\\''s here.jsonl'`);
    expect(script).toContain(`grep -F '"customType":"forge-btw'`);
    expect(() => btwEntriesScript("relative.jsonl", "pimtag1234")).toThrow();
    expect(parseEntryLines('{"a":1}\n{"cut\n\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
