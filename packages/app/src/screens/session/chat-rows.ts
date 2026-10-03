// Chat items from the host service → props for the kept Paseo chat components. Pure.

import type { ChatItem, ToolStatus } from "@/host/types";
import type { ToolCallDetail } from "@/types/protocol/agent-types";
import type { MarkdownPhase } from "@/components/markdown/fence/types";
import type { PendingEcho } from "@/stores/chat-feed";

export type ChatRow =
  | { kind: "user"; key: string; text: string; timestamp: number; pending: boolean }
  | { kind: "assistant"; key: string; text: string; timestamp: number; phase: MarkdownPhase }
  | { kind: "thinking"; key: string; text: string; live: boolean }
  | {
      kind: "tool";
      key: string;
      toolName: string;
      status: "running" | "completed" | "failed";
      detail: ToolCallDetail;
      error?: string;
    }
  | { kind: "notice"; key: string; level: "info" | "warning" | "error"; text: string }
  | { kind: "compaction"; key: string }
  | { kind: "divider"; key: string; label: string; summary?: string };

/** chat.ts marks a transcript read from the middle of its file with this notice. */
const EARLIER_TEXT = "Earlier messages are not loaded.";

function isEarlierMarker(id: string, text: string): boolean {
  return id.startsWith("earlier") && text === EARLIER_TEXT;
}

/** chat.ts labels compaction dividers with exactly this text. */
export const COMPACTION_LABEL = "Context compacted";

type Args = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pathOf(args: Args): string {
  return str(args.path) ?? str(args.file_path) ?? str(args.filePath) ?? "";
}

function editDetail(args: Args): ToolCallDetail {
  const filePath = pathOf(args);
  const edits = Array.isArray(args.edits)
    ? (args.edits as Args[]).filter((edit) => edit && typeof edit === "object")
    : [];
  if (edits.length > 0) {
    return {
      type: "edit",
      filePath,
      oldString: edits.map((edit) => str(edit.oldText) ?? str(edit.old_string) ?? "").join("\n…\n"),
      newString: edits.map((edit) => str(edit.newText) ?? str(edit.new_string) ?? "").join("\n…\n"),
    };
  }
  return {
    type: "edit",
    filePath,
    oldString: str(args.oldText) ?? str(args.old_string),
    newString: str(args.newText) ?? str(args.new_string),
  };
}

function searchDetail(name: string, args: Args, result: string | undefined): ToolCallDetail {
  const pattern = str(args.pattern) ?? str(args.query) ?? "";
  const where = pathOf(args);
  if (name === "ls") return { type: "search", query: where || ".", content: result };
  const query = where ? `${pattern} in ${where}` : pattern;
  return { type: "search", query, toolName: name === "grep" ? "grep" : "glob", content: result };
}

/** Maps pi's tool names onto the kept ToolCall detail types; anything else is "unknown". */
export function toolDetail(name: string, args: Args, result?: string): ToolCallDetail {
  switch (name) {
    case "bash":
      return { type: "shell", command: str(args.command) ?? "", output: result };
    case "read":
      return {
        type: "read",
        filePath: pathOf(args),
        content: result,
        offset: num(args.offset),
        limit: num(args.limit),
      };
    case "edit":
      return editDetail(args);
    case "write":
      return { type: "write", filePath: pathOf(args), content: str(args.content) };
    case "grep":
    case "find":
    case "ls":
      return searchDetail(name, args, result);
    default:
      return { type: "unknown", input: args, output: result ?? null };
  }
}

export function toolStatus(
  status: ToolStatus,
  isError?: boolean,
): "running" | "completed" | "failed" {
  if (status === "failed" || isError) return "failed";
  return status;
}

function itemRow(item: ChatItem, isLast: boolean, working: boolean): ChatRow | null {
  switch (item.kind) {
    case "user":
      return {
        kind: "user",
        key: item.id,
        text: item.text,
        timestamp: item.timestamp,
        pending: false,
      };
    case "assistant":
      if (!item.text.trim()) return null;
      return {
        kind: "assistant",
        key: item.id,
        text: item.text,
        timestamp: item.timestamp,
        phase: isLast && working ? "streaming" : "complete",
      };
    case "thinking":
      if (!item.text.trim()) return null;
      return { kind: "thinking", key: item.id, text: item.text, live: isLast && working };
    case "tool": {
      const status = toolStatus(item.status, item.isError);
      return {
        kind: "tool",
        key: item.id,
        toolName: item.name,
        status,
        detail: toolDetail(item.name, item.args, item.result),
        ...(status === "failed" && item.result ? { error: item.result } : {}),
      };
    }
    case "notice":
      // The host's "Earlier messages are not loaded." is the app's own words: pi shows nothing.
      if (isEarlierMarker(item.id, item.text)) return null;
      return { kind: "notice", key: item.id, level: item.level, text: item.text };
    case "divider":
      if (item.label === COMPACTION_LABEL) return { kind: "compaction", key: item.id };
      return { kind: "divider", key: item.id, label: item.label, summary: item.summary };
  }
}

/** Chronological rows; optimistic echoes go last until the transcript shows them. */
export function toChatRows(
  items: readonly ChatItem[],
  pending: readonly PendingEcho[],
  working: boolean,
): ChatRow[] {
  const rows: ChatRow[] = [];
  items.forEach((item, index) => {
    const row = itemRow(item, index === items.length - 1, working);
    if (row) rows.push(row);
  });
  for (const echo of pending) {
    rows.push({
      kind: "user",
      key: echo.id,
      text: echo.text,
      timestamp: echo.sentAt,
      pending: true,
    });
  }
  return rows;
}
