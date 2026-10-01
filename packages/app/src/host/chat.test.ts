// Chat: branch walking, tool pairing (pure ChatDocument), and incremental reads (ChatReader running
// the real host scripts through `sh` on synthetic temp files).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ChatDocument, ChatReader } from "./chat";
import { wrapForAnyShell } from "./commands";
import { HostError } from "./types";

let seq = 0;
const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const entry = (id: string, parentId: string | null, rest: Record<string, unknown>) =>
  JSON.stringify({ type: "message", id, parentId, timestamp: ts(++seq), ...rest });
const user = (id: string, parent: string | null, text: string) =>
  entry(id, parent, {
    message: { role: "user", content: [{ type: "text", text }], timestamp: seq },
  });
const asst = (
  id: string,
  parent: string | null,
  content: unknown[],
  extra: Record<string, unknown> = {},
) =>
  entry(id, parent, {
    message: { role: "assistant", content, stopReason: "stop", timestamp: seq, ...extra },
  });
const result = (id: string, parent: string, callId: string, text: string, isError = false) =>
  entry(id, parent, {
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "bash",
      content: [{ type: "text", text }],
      isError,
      timestamp: seq,
    },
  });
const header = JSON.stringify({
  type: "session",
  version: 3,
  id: "sess",
  timestamp: ts(0),
  cwd: "/w",
});

function doc(lines: string[]): ChatDocument {
  const d = new ChatDocument();
  for (const l of lines) d.addLine(l);
  return d;
}

describe("ChatDocument", () => {
  it("walks the active branch from the last entry", () => {
    const d = doc([
      header,
      user("u1", null, "first"),
      asst("a1", "u1", [{ type: "text", text: "reply one" }]),
      user("u2", "a1", "abandoned branch"),
      asst("a2", "u2", [{ type: "text", text: "abandoned reply" }]),
      JSON.stringify({
        type: "branch_summary",
        id: "b1",
        parentId: "a1",
        timestamp: ts(50),
        fromId: "a2",
        summary: "tried A",
      }),
      user("u3", "b1", "second"),
      JSON.stringify({
        type: "label",
        id: "l1",
        parentId: "u3",
        timestamp: ts(51),
        targetId: "u1",
        label: "x",
      }),
    ]);
    const items = doc([]).build().items;
    expect(items).toEqual([]);
    const built = d.build();
    expect(
      built.items.map((i) =>
        i.kind === "divider"
          ? `divider:${i.label}:${i.summary}`
          : `${i.kind}:${"text" in i ? i.text : ""}`,
      ),
    ).toEqual([
      "user:first",
      "assistant:reply one",
      "divider:Branch summary:tried A",
      "user:second",
    ]);
    expect(built.pathIds.has("u2")).toBe(false);
  });

  it("pairs tool calls with results; unanswered calls run only in the newest turn", () => {
    const d = doc([
      user("u1", null, "go"),
      asst(
        "a1",
        "u1",
        [
          { type: "thinking", thinking: "hmm" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
          { type: "toolCall", id: "c2", name: "read", arguments: { path: "x" } },
        ],
        { stopReason: "toolUse" },
      ),
      result("r1", "a1", "c1", "file.txt"),
      result("r2", "r1", "c2", "ENOENT", true),
      asst(
        "a2",
        "r2",
        [
          {
            type: "toolCall",
            id: "c3",
            name: "edit",
            arguments: { path: "y", old: "z".repeat(5000) },
          },
        ],
        { stopReason: "toolUse" },
      ),
      user("u2", "a2", "steer"),
      asst(
        "a3",
        "u2",
        [{ type: "toolCall", id: "c4", name: "bash", arguments: { command: "sleep 9" } }],
        { stopReason: "toolUse" },
      ),
    ]);
    const tools = d.build().items.filter((i) => i.kind === "tool");
    expect(
      tools.map((t) => t.kind === "tool" && [t.id, t.status, t.result ?? null, t.isError ?? false]),
    ).toEqual([
      ["c1", "completed", "file.txt", false],
      ["c2", "failed", "ENOENT", true],
      ["c3", "failed", null, true], // a later turn exists: it never got a result
      ["c4", "running", null, false],
    ]);
    const c3 = tools[2]!;
    expect(c3.kind === "tool" && String(c3.args.old).length).toBeLessThan(4100);
    expect(d.build().items[1]).toMatchObject({ kind: "thinking", text: "hmm" });
  });

  it("turns compactions into dividers, errors and aborts into notices, hides system/custom", () => {
    const d = doc([
      user("u1", null, "go"),
      entry("s1", "u1", { message: { role: "system", content: "secret prompt", timestamp: 1 } }),
      JSON.stringify({
        type: "compaction",
        id: "k1",
        parentId: "s1",
        timestamp: ts(60),
        summary: "earlier stuff",
        firstKeptEntryId: "u1",
        tokensBefore: 9,
      }),
      asst("a1", "k1", [], { stopReason: "error", errorMessage: "rate limited" }),
      asst("a2", "a1", [{ type: "thinking", thinking: "" }], {
        stopReason: "aborted",
        errorMessage: "This operation was aborted",
      }),
      JSON.stringify({
        type: "custom",
        id: "x1",
        parentId: "a2",
        timestamp: ts(61),
        customType: "forge-usage",
        data: {},
      }),
      JSON.stringify({
        type: "custom_message",
        id: "x2",
        parentId: "x1",
        timestamp: ts(62),
        customType: "forge-workflow",
        content: "workflow done",
        display: true,
      }),
      JSON.stringify({
        type: "custom_message",
        id: "x3",
        parentId: "x2",
        timestamp: ts(63),
        customType: "hidden",
        content: "nope",
        display: false,
      }),
      entry("b1", "x3", {
        message: {
          role: "bashExecution",
          command: "make",
          output: "err",
          exitCode: 2,
          cancelled: false,
          truncated: false,
          timestamp: 5,
        },
      }),
      user("u2", "b1", '<skill name="review" location="/s">\nbody\n</skill>\n\nthis pr'),
    ]);
    const items = d.build().items;
    expect(items.map((i) => i.kind)).toEqual([
      "user",
      "divider",
      "notice",
      "notice",
      "notice",
      "tool",
      "user",
    ]);
    expect(items[1]).toMatchObject({ label: "Context compacted", summary: "earlier stuff" });
    expect(items[2]).toMatchObject({ level: "error", text: "rate limited" });
    expect(items[3]).toMatchObject({ level: "warning", text: "Interrupted" });
    expect(items[4]).toMatchObject({ level: "info", text: "workflow done" });
    expect(items[5]).toMatchObject({
      name: "bash",
      status: "failed",
      args: { command: "make", userBash: true },
    });
    expect(items[6]).toMatchObject({ text: "/skill:review this pr" });
    expect(JSON.stringify(items)).not.toContain("secret prompt");
  });

  it("says when earlier messages are missing, and counts images", () => {
    const d = doc([
      user("u9", "missing", "late"),
      entry("u10", "u9", {
        message: {
          role: "user",
          content: [
            { type: "text", text: "pic" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
          timestamp: 9,
        },
      }),
    ]);
    const items = d.build().items;
    expect(items[0]).toMatchObject({ kind: "notice", text: "Earlier messages are not loaded." });
    expect(items[2]).toMatchObject({ kind: "user", text: "pic", images: 1 });
  });
});

describe("ChatReader (host scripts via sh)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pim-chat-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  let runs = 0;
  const run = async (script: string) => {
    runs++;
    const r = spawnSync("/bin/sh", ["-c", wrapForAnyShell(script)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };

  it("reads incrementally, keeps to full lines, rebuilds on shrink or replacement", async () => {
    const file = path.join(dir, "a.jsonl");
    fs.writeFileSync(file, `${header}\n${user("u1", null, "héllo ✓")}\n`);
    const reader = new ChatReader(run, 4096);
    const r1 = await reader.read(file);
    expect(r1).toMatchObject({ reset: true, more: false, truncated: false });
    expect(r1.cursor.offset).toBe(fs.statSync(file).size);
    expect(r1.items).toHaveLength(1);

    // A half-written line is not consumed.
    const a1 = asst("a1", "u1", [{ type: "text", text: "hi" }]);
    fs.appendFileSync(file, a1.slice(0, 20));
    const r2 = await reader.read(file, r1.cursor);
    expect(r2).toMatchObject({ reset: false });
    expect(r2.cursor.offset).toBe(r1.cursor.offset);
    fs.appendFileSync(file, `${a1.slice(20)}\n`);
    const r3 = await reader.read(file, r2.cursor);
    expect(r3.reset).toBe(false);
    expect(r3.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(r3.cursor.offset).toBe(fs.statSync(file).size);

    // A branch away from the old leaf resets.
    fs.appendFileSync(file, `${user("u2", "u1", "edited")}\n`);
    const r4 = await reader.read(file, r3.cursor);
    expect(r4.reset).toBe(true);
    expect(r4.items.map((i) => (i.kind === "user" ? i.text : i.kind))).toEqual([
      "héllo ✓",
      "edited",
    ]);

    // Shrink → fresh.
    fs.writeFileSync(file, `${header}\n${user("z1", null, "new file")}\n`);
    const r5 = await reader.read(file, r4.cursor);
    expect(r5.reset).toBe(true);
    expect(r5.items.map((i) => i.kind === "user" && i.text)).toEqual(["new file"]);

    // Replaced (new inode) at the same size or larger → fresh.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(
      tmp,
      `${header}\n${user("y1", null, "replaced!!")}\n${user("y2", "y1", "more")}\n`,
    );
    fs.renameSync(tmp, file);
    const r6 = await reader.read(file, r5.cursor);
    expect(r6.reset).toBe(true);
    expect(r6.items.map((i) => i.kind === "user" && i.text)).toEqual(["replaced!!", "more"]);

    // A cursor this reader does not know → full read.
    const r7 = await new ChatReader(run, 4096).read(file, r6.cursor);
    expect(r7.reset).toBe(true);
    expect(r7.items).toHaveLength(2);
  });

  it("caps each read, reports more, and starts a large file from its tail", async () => {
    const file = path.join(dir, "big.jsonl");
    const lines = [header];
    let parent: string | null = null;
    for (let i = 0; i < 200; i++) {
      lines.push(user(`m${i}`, parent, `message ${i} ${"p".repeat(80)}`));
      parent = `m${i}`;
    }
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const reader = new ChatReader(run, 2048);
    const first = await reader.read(file);
    expect(first.truncated).toBe(true);
    expect(first.items[0]).toMatchObject({
      kind: "notice",
      text: "Earlier messages are not loaded.",
    });
    expect(first.items.at(-1)).toMatchObject({ text: expect.stringContaining("message 199") });
    expect(first.cursor.offset).toBe(fs.statSync(file).size);

    // Appends larger than one read: `more` until caught up, no reset.
    let cursor = first.cursor;
    const extra: string[] = [];
    for (let i = 200; i < 260; i++) {
      extra.push(user(`m${i}`, parent, `message ${i} ${"q".repeat(80)}`));
      parent = `m${i}`;
    }
    fs.appendFileSync(file, `${extra.join("\n")}\n`);
    let update = await reader.read(file, cursor);
    let reads = 1;
    while (update.more) {
      expect(update.reset).toBe(false);
      cursor = update.cursor;
      update = await reader.read(file, cursor);
      reads++;
    }
    expect(reads).toBeGreaterThan(1);
    expect(update.cursor.offset).toBe(fs.statSync(file).size);
    expect(update.items.at(-1)).toMatchObject({ text: expect.stringContaining("message 259") });
  });

  it("shows a line longer than one read as a stub and reads on", async () => {
    const file = path.join(dir, "long.jsonl");
    const huge = "A".repeat(20_000);
    fs.writeFileSync(
      file,
      [
        header,
        user("u1", null, "look"),
        asst(
          "a1",
          "u1",
          [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "img.png" } }],
          { stopReason: "toolUse" },
        ),
      ].join("\n") + "\n",
    );
    const reader = new ChatReader(run, 4096);
    const before = await reader.read(file);
    expect(before.items.map((i) => i.kind === "tool" && i.status)).toEqual([false, "running"]);
    fs.appendFileSync(
      file,
      [
        JSON.stringify({
          type: "message",
          id: "r1",
          parentId: "a1",
          timestamp: ts(99),
          message: {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "read",
            content: [{ type: "image", data: huge, mimeType: "image/png" }],
            isError: false,
            timestamp: 1,
          },
        }),
        asst("a2", "r1", [{ type: "text", text: "a cat" }]),
      ].join("\n") + "\n",
    );
    let u = await reader.read(file, before.cursor);
    while (u.more) u = await reader.read(file, u.cursor);
    expect(u.reset).toBe(false);
    expect(u.cursor.offset).toBe(fs.statSync(file).size);
    const kinds = u.items.map((i) => i.kind);
    expect(kinds).toEqual(["user", "tool", "assistant"]);
    expect(u.items[1]).toMatchObject({
      status: "completed",
      result: expect.stringContaining("too large"),
    });
  });

  it("throws not-found for a missing file", async () => {
    await expect(new ChatReader(run).read(path.join(dir, "nope.jsonl"))).rejects.toSatisfy(
      (e: unknown) => e instanceof HostError && e.code === "not-found",
    );
    expect(runs).toBeGreaterThan(0);
  });
});
