// Chat timeline item types rendered by components/message.tsx. Adapted from Paseo's daemon stream
// model (Apache-2.0); the reducer is gone. A pi session (.jsonl) is mapped onto these items.
import type { AgentProvider, JsonValue, ToolCallDetail } from "@/types/protocol/agent-types";

export type StreamItem =
  | UserMessageItem
  | AssistantMessageItem
  | ThoughtItem
  | ToolCallItem
  | TodoListItem
  | NotificationItem
  | CompactionItem
  | PluginTimelineStreamItem;

export interface TimelinePosition {
  epoch: string;
  seq: number;
}

export interface UserMessageItem {
  kind: "user_message";
  id: string;
  messageId?: string;
  turnId?: string;
  timelineCursor?: TimelinePosition;
  text: string;
  timestamp: Date;
}

export interface AssistantMessageItem {
  kind: "assistant_message";
  id: string;
  messageId?: string;
  turnId?: string;
  timelineCursor?: TimelinePosition;
  text: string;
  timestamp: Date;
  /** Display-only fields. */
  blockGroupId?: string;
  blockIndex?: number;
}

export type ThoughtStatus = "loading" | "ready";

export interface ThoughtItem {
  kind: "thought";
  id: string;
  timelineCursor?: TimelinePosition;
  turnId?: string;
  text: string;
  timestamp: Date;
  status: ThoughtStatus;
}

export type OrchestratorToolCallStatus = "executing" | "completed" | "failed";
export type AgentToolCallStatus = "running" | "completed" | "failed" | "canceled";

interface OrchestratorToolCallData {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  result?: unknown;
  error?: unknown;
  status: OrchestratorToolCallStatus;
}

export interface AgentToolCallData {
  provider: AgentProvider;
  callId: string;
  name: string;
  status: AgentToolCallStatus;
  error: unknown;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
}

export type ToolCallPayload =
  | { source: "agent"; data: AgentToolCallData }
  | { source: "orchestrator"; data: OrchestratorToolCallData };

export interface ToolCallItem {
  kind: "tool_call";
  id: string;
  timelineCursor?: TimelinePosition;
  turnId?: string;
  timestamp: Date;
  payload: ToolCallPayload;
}

export type AgentToolCallItem = ToolCallItem & {
  payload: { source: "agent"; data: AgentToolCallData };
};

export function isAgentToolCallItem(item: StreamItem): item is AgentToolCallItem {
  return item.kind === "tool_call" && item.payload.source === "agent";
}

type NotificationLevel = "info" | "warning" | "error";

export interface NotificationItem {
  kind: "notification";
  sourceType: "error" | "notification";
  id: string;
  timelineCursor?: TimelinePosition;
  turnId?: string;
  timestamp: Date;
  level: NotificationLevel;
  message: string;
}

export interface CompactionItem {
  kind: "compaction";
  id: string;
  timelineCursor?: TimelinePosition;
  turnId?: string;
  timestamp: Date;
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

export interface PluginTimelineStreamItem {
  kind: "plugin";
  id: string;
  timelineCursor?: TimelinePosition;
  turnId?: string;
  timestamp: Date;
  pluginId: string;
  pluginItemId: string;
  itemKind: string;
  version: number;
  data: JsonValue;
}

export interface TodoEntry {
  text: string;
  completed: boolean;
  id?: string;
  status?: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export type TaskActivity =
  | { type: "created"; count: number }
  | { type: "added" | "started" | "completed"; task: string };

export interface TodoListItem {
  kind: "todo_list";
  id: string;
  timelineCursor?: TimelinePosition;
  turnId?: string;
  timestamp: Date;
  provider: AgentProvider;
  items: TodoEntry[];
  activity: TaskActivity;
}
