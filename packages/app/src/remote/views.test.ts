import { describe, expect, it } from "vitest";
import { btwEntriesScript, parseEntryLines } from "./session-file";
import {
  accountHeading,
  accountNote,
  agoText,
  btwHistory,
  changeText,
  checkpointsNewestFirst,
  checkpointTitle,
  costSections,
  costText,
  diffLines,
  exportedPath,
  exportNeedsOverwrite,
  footerParts,
  footerRef,
  leftWords,
  meterDetail,
  modelErrorKey,
  modelGroups,
  parseChangelog,
  parseCheckpointDiff,
  parseModelList,
  parsePinsResult,
  parseRewindPreview,
  parseSyncStatus,
  parseThinking,
  parseUsage,
  rewindChoices,
  rewindLine,
  rewindPrompts,
  sessionName,
  syncDone,
  tailText,
  taskRows,
  usageAt,
  taskView,
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
  compactAt: 83,
  compactionPaused: false,
  contextTone: "normal",
  items: [],
  ...over,
});

describe("/rewind", () => {
  const v12 = {
    entryId: "e9",
    quote: "Update the README",
    at: 1790000000000,
    heading: "code",
    row: "3 files changed +17 -4",
    code: {
      files: ["README.md", "a.ts", "b.ts"],
      added: 4,
      removed: 17,
      counted: true,
      sentence: "The code will be restored +4 -17 in README.md and 2 other files.",
    },
    modes: ["both", "conversation", "code"],
    warnings: ["! m.txt left alone"],
  };

  it("reads rewind.preview as forge builds it (v1.2)", () => {
    const preview = parseRewindPreview(v12);
    expect(preview).toMatchObject({ entryId: "e9", heading: "code", modes: v12.modes });
    expect(preview?.code?.sentence).toBe(v12.code.sentence);
    expect(preview?.warnings).toEqual(["! m.txt left alone"]);
    expect(rewindLine(preview!)).toBe("3 files changed +17 -4");
    expect(rewindChoices(preview)).toEqual(["both", "conversation", "code", "cancel"]);
  });

  it("offers only the conversation for an untracked prompt, and reads defensively", () => {
    const conv = parseRewindPreview({
      ...v12,
      heading: "conversation",
      row: null,
      code: null,
      modes: ["conversation"],
    });
    expect(rewindLine(conv!)).toBe("");
    expect(rewindChoices(conv)).toEqual(["conversation", "cancel"]);
    expect(rewindChoices(null)).toEqual(["conversation", "cancel"]);
    expect(parseRewindPreview(null)).toBeNull();
    expect(parseRewindPreview({ files: 2 })).toBeNull();
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
    expect(changeText(2, 1, 0)).toBe("2 files changed +1");
    expect(changeText(0, 0, 0)).toBe("No code changes");
    expect(checkpointTitle({ ...cp(2), label: "Add a bucket · 2 files changed" }, "x")).toBe(
      "2: Add a bucket · 2 files changed",
    );
    expect(checkpointTitle(cp(3), "Checkpoint")).toBe("3: Checkpoint · 3 files changed +1");
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

  it("tails shells only; agents show their transcript, runs their detail", () => {
    expect(taskView(task("a", "running"))).toBe("tail");
    expect(taskView({ ...task("b", "done"), kind: "agent", sessionFile: "/s.jsonl" })).toBe(
      "transcript",
    );
    expect(taskView({ ...task("c", "done"), kind: "workflow", logPath: "/x.log" })).toBe("detail");
  });
});

describe("/model", () => {
  const list = parseModelList({
    available: [
      { ref: "anthropic/opus", name: "Opus 5.5" },
      { ref: "openai/gpt", name: "GPT 6" },
      { ref: "anthropic/opus", name: "dup" },
      { ref: "google/gem" },
      { name: "no ref" },
    ],
    current: "openai/gpt",
    thinking: { level: "high", levels: ["off", "low", "high"] },
  });
  const available = list.available;

  it("parses unique refs, falling back to the ref for the name", () => {
    expect(available.map((m) => m.ref)).toEqual(["anthropic/opus", "openai/gpt", "google/gem"]);
    expect(available[2].name).toBe("google/gem");
    expect(list.current).toBe("openai/gpt");
    expect(list.thinking).toEqual({ level: "high", levels: ["off", "low", "high"] });
    expect(parseModelList({ available: [], current: null, thinking: null }).thinking).toBeNull();
    expect(parseThinking({ level: "low", levels: ["off", "low"] })?.level).toBe("low");
    expect(
      parsePinsResult({ pinned: true, pins: { pinned: ["a/b"], recent: ["c/d", 3] } }),
    ).toEqual({ pinned: ["a/b"], recent: ["c/d"] });
  });

  it("shows only the pins with no query, in saved order, and models unpinned here for undo", () => {
    const pins = { pinned: ["openai/gpt", "gone/model"], recent: ["google/gem"] };
    expect(groupRefs(modelGroups(available, pins))).toEqual([
      ["pinned", ["openai/gpt", "gone/model"]],
    ]);
    expect(groupRefs(modelGroups(available, pins, "", ["anthropic/opus", "openai/gpt"]))).toEqual([
      ["pinned", ["openai/gpt", "gone/model"]],
      ["unpinned", ["anthropic/opus"]],
    ]);
    expect(modelGroups(available, undefined)).toEqual([]);
  });

  it("searches pins first, then other models, folding - _ and spaces, exact first", () => {
    const pins = { pinned: ["openai/gpt"], recent: [] };
    expect(groupRefs(modelGroups(available, pins, "o"))).toEqual([
      ["pinned", ["openai/gpt"]],
      ["other", ["anthropic/opus", "google/gem"]],
    ]);
    expect(groupRefs(modelGroups(available, pins, "opus 5.5"))).toEqual([
      ["other", ["anthropic/opus"]],
    ]);
    expect(groupRefs(modelGroups(available, pins, "gpt6"))).toEqual([["pinned", ["openai/gpt"]]]);
    expect(modelGroups(available, pins, "nothing-like-it")).toEqual([]);
    const two = [
      { ref: "a/gem-pro", name: "Gem Pro" },
      { ref: "a/gem", name: "Gem" },
    ];
    expect(groupRefs(modelGroups(two, undefined, "gem"))).toEqual([
      ["other", ["a/gem", "a/gem-pro"]],
    ]);
  });

  it("knows the footer's model ref, never 'unknown'", () => {
    expect(footerRef(footer())).toBe("anthropic/claude-opus-5-5");
    expect(
      footerRef(footer({ model: { provider: "", id: "unknown", name: "", thinking: null } })),
    ).toBeNull();
  });
});

describe("footer", () => {
  const text = (f: RemoteFooter | null) => footerParts(f).map((p) => p.text);

  it("shows exactly what the desktop status line shows", () => {
    expect(text(footer())).toEqual(["Opus 5.5", "high", "ctx 12%/200k", "~$0.420"]);
    expect(text(footer({ cost: null, model: { ...footer().model!, thinking: null } }))).toEqual([
      "Opus 5.5",
      "ctx 12%/200k",
    ]);
    expect(text(footer({ model: null }))).toEqual(["ctx 12%/200k", "~$0.420"]);
    expect(text(footer({ contextWindow: null }))).toEqual(["Opus 5.5", "high", "~$0.420"]);
    expect(text(footer({ items: ["1 shell", "◷ wakes in 23m"] })).slice(-2)).toEqual([
      "1 shell",
      "◷ wakes in 23m",
    ]);
    expect(text(null)).toEqual([]);
  });

  it("adds the compaction hint from 3/4 of the way, with the line's colour", () => {
    const near = footerParts(
      footer({ contextPercent: 70, contextTokens: 140_000, contextTone: "warning" }),
    );
    expect(near[2]).toEqual({
      text: "ctx 70%/200k · compacts at 83%",
      kind: "context",
      tone: "warning",
    });
    expect(footerParts(footer({ contextTokens: 100_000 }))[2].text).toBe("ctx 12%/200k");
    expect(footerParts(footer({ compactionPaused: true }))[2]).toEqual({
      text: "ctx 12%/200k · compaction paused",
      kind: "context",
      tone: "warning",
    });
    expect(
      footerParts(footer({ contextPercent: null, contextTokens: null, compactionPaused: true }))[2]
        .text,
    ).toBe("compaction paused");
  });

  it("words counts and amounts as the line does", () => {
    expect(windowText(1_000_000)).toBe("1.0M");
    expect(windowText(272_000)).toBe("272k");
    expect(windowText(50_000)).toBe("50.0k");
    expect(costText(0.0421)).toBe("$0.0421");
    expect(costText(1.234)).toBe("$1.234");
    expect(costText(12.5)).toBe("$12.50");
    expect(costText(0)).toBe("$0");
  });
});

describe("/usage and /cost", () => {
  const now = 1_790_000_000_000;

  it("reads v1.2 accounts: plan, ratio bars, reset words; never who is signed in", () => {
    const accounts = parseUsage({
      at: now,
      accounts: [
        {
          id: "claude",
          name: "Claude",
          plan: "Max 20x",
          meters: [
            {
              label: "5-hour",
              ratio: 0.93,
              value: "93% left",
              detail: null,
              resetsAt: now + 5.5 * 3600_000,
            },
            { label: "Weekly", ratio: 1.4, value: "100% left", detail: "Fable", resetsAt: null },
            { nope: 1 },
          ],
          asOf: now,
          fetchedAt: now,
          problem: null,
          empty: null,
        },
        {
          id: "openrouter",
          name: "OpenRouter",
          plan: null,
          meters: [],
          asOf: null,
          fetchedAt: now,
          problem: null,
          empty: "No key",
        },
        { plan: "untitled" },
      ],
    });
    expect(accounts.map(accountHeading)).toEqual(["Claude · Max 20x", "OpenRouter"]);
    expect(accounts[0].meters.map((m) => m.ratio)).toEqual([0.93, 1]);
    expect(meterDetail(accounts[0].meters[0], now)).toBe("Resets in 5h 30m");
    expect(meterDetail(accounts[0].meters[1], now)).toBe("Fable");
    expect(accountNote(accounts[0], now)).toBeNull();
    expect(accountNote(accounts[1], now)).toEqual({ text: "No key", error: false });
    expect(parseUsage(null)).toEqual([]);
    expect(leftWords(45_000)).toBe("45s");
    expect(leftWords(3 * 86_400_000 + 21 * 3600_000)).toBe("3d 21h");
  });

  it("counts reset time from forge's snapshot clock, not the phone's", () => {
    const data = {
      at: now,
      accounts: [
        {
          id: "claude",
          name: "Claude",
          meters: [
            { label: "5-hour", ratio: 0.9, value: "90% left", resetsAt: now + 5.5 * 3600_000 },
          ],
        },
      ],
    };
    expect(usageAt(data)).toBe(now);
    expect(usageAt(null)).toBeNull();
    // A phone clock 40 s behind the host would read "5h 31m"; the host's snapshot time reads 5h 30m.
    const [a] = parseUsage(data);
    expect(meterDetail(a.meters[0], usageAt(data)!)).toBe("Resets in 5h 30m");
    expect(meterDetail(a.meters[0], now - 40_000)).toBe("Resets in 5h 31m");
  });

  it("says why an account has no numbers, as the panel does", () => {
    const [a] = parseUsage({
      accounts: [{ id: "codex", name: "ChatGPT", meters: [], problem: "timed out", asOf: null }],
    });
    expect(accountNote(a, now)).toEqual({ text: "Couldn't reach ChatGPT: timed out", error: true });
  });

  it("reads cost.read sections", () => {
    expect(
      costSections({
        sections: [
          { title: null, rows: [{ label: "File", value: "/s.jsonl", indent: false }] },
          {
            title: "Tokens",
            rows: [
              { label: "Input", value: "1,200", indent: true },
              { label: "Total", value: null, indent: false },
            ],
          },
          { title: null, rows: [] },
        ],
      }),
    ).toEqual([
      { title: null, rows: [{ label: "File", value: "/s.jsonl", indent: false }] },
      {
        title: "Tokens",
        rows: [
          { label: "Input", value: "1,200", indent: true },
          { label: "Total", value: null, indent: false },
        ],
      },
    ]);
    expect(costSections(null)).toEqual([]);
  });
});

describe("/pause", () => {
  const now = new Date(2026, 9, 2, 14, 0, 0);

  it("takes 1–1440 minutes and sends seconds (forge reads a number `in` as seconds)", () => {
    expect(wakeArgs("in", "30", " CI ", now)).toEqual({
      ok: true,
      args: { in: 1800, reason: "CI" },
    });
    expect(wakeArgs("in", "", "", now)).toEqual({ ok: false, error: "minutes" });
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
  it("reads export, sync and changelog data (v1.2)", () => {
    expect(exportedPath({ path: "/w/notes.md" })).toBe("/w/notes.md");
    expect(exportedPath(null)).toBeNull();
    expect(exportNeedsOverwrite("exists")).toBe(true);
    expect(exportNeedsOverwrite("gate")).toBe(false);
    expect(exportNeedsOverwrite(undefined)).toBe(false);
    expect(parseSyncStatus({ text: "setup: ok\nclean", level: "info" })).toEqual({
      text: "setup: ok\nclean",
      level: "info",
    });
    expect(parseSyncStatus({ text: "x", level: "error" })?.level).toBe("error");
    expect(parseSyncStatus({})).toBeNull();
    expect(syncDone({ done: true })).toBe(true);
    expect(syncDone({ done: false })).toBe(false);
    expect(parseChangelog({ markdown: "# 1.0", truncated: true })).toEqual({
      markdown: "# 1.0",
      truncated: true,
    });
    expect(parseChangelog({})).toEqual({ markdown: "", truncated: false });
    const long = `## 2.0\n\n${"a".repeat(30)}\n## 1.0\n\n${"b".repeat(30)}\n`;
    expect(parseChangelog({ markdown: long, truncated: false }, 50)).toEqual({
      markdown: `## 2.0\n\n${"a".repeat(30)}`,
      truncated: true,
    });
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

describe("modelErrorKey", () => {
  it("maps pi's raw provider errors to plain copy, leaving plain text alone", () => {
    expect(modelErrorKey("Unknown provider: unknown")).toBe("notSetUp");
    expect(modelErrorKey("No API key found for anthropic")).toBe("auth");
    expect(modelErrorKey("401 Unauthorized")).toBe("auth");
    expect(modelErrorKey("Connection error.")).toBe("connection");
    expect(modelErrorKey("The answer was cut short.")).toBeNull();
  });
});
