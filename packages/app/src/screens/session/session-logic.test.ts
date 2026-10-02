import { describe, expect, it } from "vitest";
import { HostError, type ChatItem } from "@/host/types";
import { SshError } from "@/ssh/errors";
import { toChatRows, toolDetail, toolStatus } from "./chat-rows";
import { friendlyHostError } from "./send-errors";

describe("toolDetail: pi tool names → ToolCall details", () => {
  it("maps bash, read, edit, write", () => {
    expect(toolDetail("bash", { command: "ls -la" }, "out")).toEqual({
      type: "shell",
      command: "ls -la",
      output: "out",
    });
    expect(toolDetail("read", { path: "a.ts", offset: 10, limit: 5 }, "x")).toEqual({
      type: "read",
      filePath: "a.ts",
      content: "x",
      offset: 10,
      limit: 5,
    });
    expect(toolDetail("edit", { path: "a.ts", oldText: "a", newText: "b" })).toEqual({
      type: "edit",
      filePath: "a.ts",
      oldString: "a",
      newString: "b",
    });
    expect(
      toolDetail("edit", {
        path: "a.ts",
        edits: [
          { oldText: "a", newText: "b" },
          { oldText: "c", newText: "d" },
        ],
      }),
    ).toMatchObject({ type: "edit", oldString: "a\n…\nc", newString: "b\n…\nd" });
    expect(toolDetail("write", { path: "b.md", content: "# x" })).toEqual({
      type: "write",
      filePath: "b.md",
      content: "# x",
    });
  });

  it("maps grep, find and ls to search, anything else to unknown", () => {
    expect(toolDetail("grep", { pattern: "TODO", path: "src" }, "hits")).toEqual({
      type: "search",
      query: "TODO in src",
      toolName: "grep",
      content: "hits",
    });
    expect(toolDetail("find", { pattern: "*.ts" })).toMatchObject({
      type: "search",
      query: "*.ts",
      toolName: "glob",
    });
    expect(toolDetail("ls", { path: "src" })).toMatchObject({ type: "search", query: "src" });
    expect(toolDetail("subagent", { task: "x" }, "r")).toEqual({
      type: "unknown",
      input: { task: "x" },
      output: "r",
    });
  });

  it("marks errored results as failed", () => {
    expect(toolStatus("completed", true)).toBe("failed");
    expect(toolStatus("running")).toBe("running");
  });
});

describe("toChatRows", () => {
  const items: ChatItem[] = [
    { kind: "user", id: "u", text: "go", images: 0, timestamp: 1 },
    { kind: "thinking", id: "th", text: "hmm", timestamp: 2 },
    {
      kind: "tool",
      id: "t",
      name: "bash",
      args: { command: "false" },
      status: "completed",
      isError: true,
      result: "exit 1",
      timestamp: 3,
    },
    { kind: "divider", id: "d", label: "Context compacted", timestamp: 4 },
    { kind: "divider", id: "b", label: "Branch summary", summary: "s", timestamp: 5 },
    { kind: "notice", id: "n", level: "warning", text: "Interrupted", timestamp: 6 },
    { kind: "assistant", id: "a", text: "Done", timestamp: 7 },
  ];

  it("maps every kind in order and streams the last reply while working", () => {
    const rows = toChatRows(items, [], true);
    expect(rows.map((r) => r.kind)).toEqual([
      "user",
      "thinking",
      "tool",
      "compaction",
      "divider",
      "notice",
      "assistant",
    ]);
    expect(rows[2]).toMatchObject({ status: "failed", error: "exit 1", toolName: "bash" });
    expect(rows[6]).toMatchObject({ phase: "streaming" });
    expect(toChatRows(items, [], false)[6]).toMatchObject({ phase: "complete" });
  });

  it("appends pending echoes and skips empty text", () => {
    const rows = toChatRows(
      [{ kind: "assistant", id: "a", text: "  ", timestamp: 1 }],
      [{ id: "p1", text: "next", sentAt: 9, baseline: 0 }],
      false,
    );
    expect(rows).toEqual([{ kind: "user", key: "p1", text: "next", timestamp: 9, pending: true }]);
  });
});

describe("friendlyHostError", () => {
  it("maps HostError codes to friendly keys", () => {
    expect(friendlyHostError(new HostError("waiting-for-input", "x"))).toEqual({
      key: "pi.session.errors.waiting-for-input",
    });
    expect(friendlyHostError(new HostError("pane-busy", "x")).key).toBe(
      "pi.session.errors.pane-busy",
    );
    expect(friendlyHostError(new HostError("prompt-too-large", "x")).key).toBe(
      "pi.session.errors.prompt-too-large",
    );
    expect(friendlyHostError(new HostError("session-live", "x")).key).toBe(
      "pi.session.errors.session-live",
    );
    expect(friendlyHostError(new HostError("command-failed", "tmux died"))).toEqual({
      key: "pi.session.errors.command-failed",
      detail: "tmux died",
    });
  });

  it("recognizes a dropped connection", () => {
    expect(friendlyHostError(new SshError("ERR_SSH_NOT_CONNECTED", "x")).key).toBe(
      "pi.session.errors.connection",
    );
  });
});
