// pi session .jsonl → ChatItem[] for the active branch, read incrementally over SSH.
//
// The leaf is the last entry in the file (pi appends every entry as a child of its current leaf);
// the branch is its parentId chain. Each read fetches at most `cap` bytes after the cursor, keeps
// to the last full line, and rebuilds when the file shrank, was replaced (inode) or the byte
// before the cursor is not a newline. A first read of a large file starts `cap` bytes before the
// end, then hydrates missing branch ancestors in bounded backward windows. A line longer than
// one read (an inlined image)
// becomes a stub: its id/parentId are read from its first bytes, its content is not shown.

import { chatReadScript, longLineScript, makeNonce } from "./commands";
import { base64Decode, utf8Decode } from "./encoding";
import {
  HostError,
  type ChatItem,
  type ChatUpdate,
  type SessionCursor,
  type ToolStatus,
} from "./types";

export const DEFAULT_CHAT_CAP = 1024 * 1024;
const THINKING_CAP = 20_000;
const RESULT_CAP = 8_000;
const ARG_STRING_CAP = 4_000;
const NOTICE_CAP = 2_000;

// ---------------------------------------------------------------------------
// Compact entries
// ---------------------------------------------------------------------------

type Block =
  | { t: "text"; text: string }
  | { t: "thinking"; text: string }
  | { t: "tool"; id: string; name: string; args: Record<string, unknown> };

export interface ChatNode {
  id: string;
  parent: string | null;
  type: string;
  customType?: string;
  ts: number;
  role?: string;
  text?: string;
  images?: number;
  blocks?: Block[];
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  exitCode?: number | null;
  cancelled?: boolean;
  display?: boolean;
  summary?: string;
  /** Bytes of a line too long to read: shown as a placeholder. */
  stub?: number;
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

function capArgs(value: unknown, depth = 0): unknown {
  if (typeof value === "string")
    return value.length > ARG_STRING_CAP ? capText(value, ARG_STRING_CAP) : value;
  if (!value || typeof value !== "object") return value;
  if (depth > 6) return "…";
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => capArgs(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = capArgs(v, depth + 1);
  return out;
}

function partsText(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  const texts: string[] = [];
  let images = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
    else if (p.type === "image") images++;
  }
  return { text: texts.join("\n"), images };
}

const SKILL_BLOCK =
  /^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** pi stores `/skill:name args` expanded; show it as typed (forge's typedText, simplified). */
export function typedText(text: string): string {
  const skill = SKILL_BLOCK.exec(text);
  if (!skill) return text;
  const args = skill[2]?.trim();
  return `/skill:${skill[1]}${args ? ` ${args}` : ""}`;
}

function timeOf(entry: Record<string, unknown>, message?: Record<string, unknown>): number {
  const m = message?.timestamp;
  if (typeof m === "number" && Number.isFinite(m)) return m;
  if (typeof entry.timestamp === "string") {
    const t = Date.parse(entry.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

type Message = Record<string, unknown>;

function assistantBlock(raw: unknown): Block | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  if (b.type === "text" && typeof b.text === "string") return { t: "text", text: b.text };
  if (b.type === "thinking" && typeof b.thinking === "string")
    return { t: "thinking", text: capText(b.thinking, THINKING_CAP) };
  if (b.type === "toolCall" && typeof b.id === "string")
    return {
      t: "tool",
      id: b.id,
      name: typeof b.name === "string" ? b.name : "tool",
      args:
        b.arguments && typeof b.arguments === "object" && !Array.isArray(b.arguments)
          ? (capArgs(b.arguments) as Record<string, unknown>)
          : {},
    };
  return undefined;
}

function compactUser(node: ChatNode, message: Message): void {
  const { text, images } = partsText(message.content);
  node.text = typedText(text);
  node.images = images;
}

function compactAssistant(node: ChatNode, message: Message): void {
  const blocks: Block[] = [];
  if (Array.isArray(message.content)) {
    for (const raw of message.content) {
      const block = assistantBlock(raw);
      if (block) blocks.push(block);
    }
  }
  node.blocks = blocks;
  if (typeof message.stopReason === "string") node.stopReason = message.stopReason;
  if (typeof message.errorMessage === "string") node.errorMessage = message.errorMessage;
}

/** "[2 images]" after a tool result's text, on its own line when there is text. */
function imagesNote(text: string, images: number): string {
  if (images <= 0) return "";
  return `${text ? "\n" : ""}[${images} image${images === 1 ? "" : "s"}]`;
}

function compactToolResult(node: ChatNode, message: Message): void {
  const { text, images } = partsText(message.content);
  node.toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
  node.toolName = typeof message.toolName === "string" ? message.toolName : "tool";
  node.isError = message.isError === true;
  node.text = capText(text, RESULT_CAP) + imagesNote(text, images);
}

function compactBash(node: ChatNode, message: Message): void {
  node.command = typeof message.command === "string" ? message.command : "";
  node.text = capText(typeof message.output === "string" ? message.output : "", RESULT_CAP);
  node.exitCode = typeof message.exitCode === "number" ? message.exitCode : null;
  node.cancelled = message.cancelled === true;
}

function compactCustom(node: ChatNode, message: Message): void {
  node.display = message.display === true;
  if (node.display) node.text = capText(partsText(message.content).text, NOTICE_CAP);
}

function compactMessage(node: ChatNode, entry: Record<string, unknown>, message: Message): void {
  node.ts = timeOf(entry, message);
  const role = typeof message.role === "string" ? message.role : "unknown";
  node.role = role;
  switch (role) {
    case "user":
      compactUser(node, message);
      break;
    case "assistant":
      compactAssistant(node, message);
      break;
    case "toolResult":
      compactToolResult(node, message);
      break;
    case "bashExecution":
      compactBash(node, message);
      break;
    case "custom":
      compactCustom(node, message);
      break;
    default:
      break;
  }
}

export function compactEntry(entry: Record<string, unknown>): ChatNode | undefined {
  if (typeof entry.id !== "string" || !entry.id || typeof entry.type !== "string") return undefined;
  const parent = typeof entry.parentId === "string" ? entry.parentId : null;
  const node: ChatNode = { id: entry.id, parent, type: entry.type, ts: timeOf(entry) };
  if (typeof entry.customType === "string") node.customType = entry.customType;
  switch (entry.type) {
    case "message": {
      const message = entry.message as Message | undefined;
      if (message && typeof message === "object") compactMessage(node, entry, message);
      return node;
    }
    case "compaction":
    case "branch_summary":
      node.summary = typeof entry.summary === "string" ? entry.summary : undefined;
      return node;
    case "custom_message":
      node.display = entry.display === true;
      if (node.display) node.text = capText(partsText(entry.content).text, NOTICE_CAP);
      return node;
    default:
      return node;
  }
}

const STUB_HEAD = /^\{"type":"([^"]+)","id":"([^"]+)","parentId":(?:null|"([^"]+)")/;

/** A stub from the first bytes of a line too long to read; undefined when its id is not up front. */
export function stubEntry(prefix: string, length: number): ChatNode | undefined {
  const head = STUB_HEAD.exec(prefix);
  if (!head) return undefined;
  const node: ChatNode = {
    id: head[2]!,
    parent: head[3] ?? null,
    type: head[1]!,
    ts: 0,
    stub: length,
  };
  const customType = /"customType":"([^"]+)"/.exec(prefix);
  if (customType) node.customType = customType[1];
  const ts = /"timestamp":"([^"]+)"/.exec(prefix);
  if (ts) node.ts = Date.parse(ts[1]!) || 0;
  const role = /"message":\{"role":"([^"]+)"/.exec(prefix);
  if (role) node.role = role[1];
  const call = /"toolCallId":"([^"]+)"/.exec(prefix);
  if (call) node.toolCallId = call[1];
  const name = /"toolName":"([^"]+)"/.exec(prefix);
  if (name) node.toolName = name[1];
  return node;
}

// ---------------------------------------------------------------------------
// Document: entries by id + the active branch as items
// ---------------------------------------------------------------------------

const ABORT_WORDS = /abort/i;

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type NoticeLevel = Extract<ChatItem, { kind: "notice" }>["level"];

/** The items of one branch, added root first; tool results settle the calls they answer. */
class BranchBuilder {
  readonly items: ChatItem[] = [];
  private readonly tools = new Map<string, ToolItem>();
  // Which assistant message each pending tool call belongs to, to settle it at the end.
  private readonly pending: Array<{ item: ToolItem; index: number; stop?: string }> = [];
  private lastTurnIndex = -1;
  private readonly usedIds = new Set<string>();

  private uniqueId(id: string): string {
    let out = id;
    for (let n = 2; this.usedIds.has(out); n++) out = `${id}#${n}`;
    this.usedIds.add(out);
    return out;
  }

  notice(id: string, level: NoticeLevel, text: string, timestamp: number): void {
    this.items.push({ kind: "notice", id: this.uniqueId(id), level, text, timestamp });
  }

  add(node: ChatNode, index: number): void {
    if (node.stub !== undefined) this.addStub(node, node.stub);
    else if (node.type === "message") this.addMessage(node, index);
    else this.addEntry(node);
  }

  /** A call with no result: still running only in the newest turn that stopped for tools. */
  settle(): void {
    for (const { item, index, stop } of this.pending) {
      if (item.status !== "running") continue;
      if (stop === "aborted" || stop === "error" || index < this.lastTurnIndex) {
        item.status = "failed";
        item.isError = true;
      }
    }
  }

  private addStub(node: ChatNode, stub: number): void {
    const size = `${Math.round(stub / 1024)} KiB`;
    const tool =
      node.role === "toolResult" && node.toolCallId ? this.tools.get(node.toolCallId) : undefined;
    if (tool) {
      tool.status = "completed";
      tool.result = `(output too large to show: ${size})`;
    } else if (node.type === "message") {
      this.notice(node.id, "info", `(entry too large to show: ${size})`, node.ts);
    }
  }

  private addMessage(node: ChatNode, index: number): void {
    switch (node.role) {
      case "user":
        this.lastTurnIndex = index;
        this.addUser(node);
        return;
      case "assistant":
        this.lastTurnIndex = index;
        this.addAssistant(node, index);
        return;
      case "toolResult":
        this.addToolResult(node);
        return;
      case "bashExecution":
        this.addBash(node);
        return;
      case "custom":
        if (node.display && node.text?.trim()) this.notice(node.id, "info", node.text, node.ts);
        return;
      default:
        return; // system, branchSummary, compactionSummary, unknown roles
    }
  }

  private addUser(node: ChatNode): void {
    if (!node.text && !node.images) return;
    this.items.push({
      kind: "user",
      id: this.uniqueId(node.id),
      text: node.text ?? "",
      images: node.images ?? 0,
      timestamp: node.ts,
    });
  }

  private addAssistant(node: ChatNode, index: number): void {
    (node.blocks ?? []).forEach((block, b) => this.addBlock(node, block, b, index));
    this.addStopNotice(node);
  }

  private addBlock(node: ChatNode, block: Block, b: number, index: number): void {
    if (block.t === "tool") this.addToolCall(node, block, index);
    else if (!block.text.trim()) return;
    else if (block.t === "text")
      this.items.push({
        kind: "assistant",
        id: this.uniqueId(`${node.id}:${b}`),
        text: block.text,
        timestamp: node.ts,
      });
    else
      this.items.push({
        kind: "thinking",
        id: this.uniqueId(`${node.id}:${b}`),
        text: block.text,
        timestamp: node.ts,
      });
  }

  private addToolCall(node: ChatNode, block: Extract<Block, { t: "tool" }>, index: number): void {
    const item: ToolItem = {
      kind: "tool",
      id: this.uniqueId(block.id),
      name: block.name,
      args: block.args,
      status: "running",
      timestamp: node.ts,
    };
    this.items.push(item);
    this.tools.set(block.id, item);
    this.pending.push({ item, index, stop: node.stopReason });
  }

  private addStopNotice(node: ChatNode): void {
    if (
      node.stopReason === "aborted" ||
      (node.stopReason === "error" && ABORT_WORDS.test(node.errorMessage ?? ""))
    )
      this.notice(`${node.id}:stop`, "warning", "Interrupted", node.ts);
    else if (node.stopReason === "error")
      this.notice(
        `${node.id}:stop`,
        "error",
        node.errorMessage?.trim() || "The run failed.",
        node.ts,
      );
  }

  private addToolResult(node: ChatNode): void {
    const status: ToolStatus = node.isError ? "failed" : "completed";
    let tool = node.toolCallId ? this.tools.get(node.toolCallId) : undefined;
    if (!tool) {
      tool = {
        kind: "tool",
        id: this.uniqueId(node.toolCallId || node.id),
        name: node.toolName ?? "tool",
        args: {},
        status,
        timestamp: node.ts,
      };
      this.items.push(tool);
      if (node.toolCallId) this.tools.set(node.toolCallId, tool);
    }
    tool.status = status;
    tool.result = node.text ?? "";
    if (node.isError) tool.isError = true;
  }

  private addBash(node: ChatNode): void {
    const ok = node.exitCode === 0 && !node.cancelled;
    const item: ToolItem = {
      kind: "tool",
      id: this.uniqueId(node.id),
      name: "bash",
      args: { command: node.command ?? "", userBash: true },
      status: ok ? "completed" : "failed",
      result: node.text ?? "",
      timestamp: node.ts,
    };
    if (!ok) item.isError = true;
    this.items.push(item);
  }

  /** Entries other than messages: compaction and branch summaries, displayed custom messages. */
  private addEntry(node: ChatNode): void {
    if (node.type === "compaction") this.divider(node, "Context compacted");
    else if (node.type === "branch_summary") this.divider(node, "Branch summary");
    else if (node.type === "custom_message" && node.display && node.text?.trim())
      this.notice(node.id, "info", node.text, node.ts);
  }

  private divider(node: ChatNode, label: string): void {
    this.items.push({
      kind: "divider",
      id: this.uniqueId(node.id),
      label,
      ...(node.summary ? { summary: node.summary } : {}),
      timestamp: node.ts,
    });
  }
}

export class ChatDocument {
  readonly nodes = new Map<string, ChatNode>();
  leaf: string | undefined;
  /** The document starts after the file's start (a tail read of a large file). */
  truncated = false;

  reset(): void {
    this.nodes.clear();
    this.leaf = undefined;
    this.truncated = false;
  }

  addNode(node: ChatNode): void {
    this.nodes.set(node.id, node);
    this.leaf = node.id;
  }

  /** One jsonl line; the session header and unparsable lines are skipped. */
  addLine(line: string): void {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!text.trim()) return;
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      return;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    if (record.type === "session") return;
    const node = compactEntry(record);
    if (node) this.addNode(node);
  }

  /** Leaf → root, root first. `broken`: an ancestor is missing (not loaded or unreadable). */
  path(): { nodes: ChatNode[]; broken: boolean } {
    const out: ChatNode[] = [];
    const seen = new Set<string>();
    let id = this.leaf;
    let broken = false;
    while (id !== undefined) {
      if (seen.has(id)) break;
      const node = this.nodes.get(id);
      if (!node) {
        broken = true;
        break;
      }
      seen.add(id);
      out.push(node);
      id = node.parent ?? undefined;
    }
    out.reverse();
    return { nodes: out, broken };
  }

  build(): { items: ChatItem[]; pathIds: Set<string> } {
    const { nodes, broken } = this.path();
    const branch = new BranchBuilder();
    const boundary = nodes.findLastIndex((node) => node.customType === "forge-side-boundary");
    if (boundary < 0 && (broken || (this.truncated && nodes[0]?.parent)))
      branch.notice("earlier", "info", "Earlier messages are not loaded.", nodes[0]?.ts ?? 0);
    nodes.slice(boundary + 1).forEach((node, index) => branch.add(node, index));
    branch.settle();
    return { items: branch.items, pathIds: new Set(nodes.map((node) => node.id)) };
  }
}

/** Adds the complete lines of `bytes` from `from`; returns the position after the last newline. */
function addLines(doc: ChatDocument, bytes: Uint8Array, from: number): number {
  let pos = from;
  for (let i = bytes.indexOf(10, pos); i >= 0; i = bytes.indexOf(10, pos)) {
    doc.addLine(utf8Decode(bytes, pos, i));
    pos = i + 1;
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Incremental reader
// ---------------------------------------------------------------------------

export type ScriptRunner = (script: string) => Promise<string>;

export interface ChatUpdateEx extends ChatUpdate {
  /** More bytes are already on the host: call again soon with the returned cursor. */
  more: boolean;
  /** History before the loaded window is not shown (large file read from its tail). */
  truncated: boolean;
}

interface FileState {
  doc: ChatDocument;
  offset: number;
  inode: string;
  /** Backward scan cursor and a partial line, bounded to one cap-sized window. */
  history?: { end: number; suffix: Uint8Array; length: number };
}

/** A backward read is mergeable only from the same, unshrunk file and exactly the asked range. */
function validBackRead(
  header: string[] | undefined,
  start: number,
  length: number,
  end: number,
  st: FileState,
  cap: number,
): boolean {
  return (
    header?.[0] === "D" &&
    header[1] === "back" &&
    header[3] === st.inode &&
    // Same inode truncated beneath what was already read: the selected leaf may be gone.
    Number(header[2]) >= st.offset &&
    Number.isSafeInteger(start) &&
    start >= 0 &&
    start < end &&
    length === end - start &&
    length <= cap
  );
}

function section(stdout: string, nonce: string): { header: string[] | undefined; body: string } {
  const lines = stdout.split("\n");
  const prefix = `${nonce} `;
  let header: string[] | undefined;
  const body: string[] = [];
  let inBody = false;
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      const parts = line.slice(prefix.length).trim().split(" ");
      if (parts[0] === "Z") break;
      header = parts;
      inBody = true;
      continue;
    }
    if (inBody) body.push(line);
  }
  return { header, body: body.join("") };
}

export class ChatReader {
  private readonly states = new Map<string, FileState>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly run: ScriptRunner,
    private readonly cap: number = DEFAULT_CHAT_CAP,
  ) {}

  forget(file: string): void {
    this.states.delete(file);
  }

  /** Reads of one file run one at a time. */
  read(file: string, cursor?: SessionCursor): Promise<ChatUpdateEx> {
    const previous = this.locks.get(file) ?? Promise.resolve();
    const next = previous.then(() => this.readNow(file, cursor));
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(file, settled);
    void settled.then(() => {
      if (this.locks.get(file) === settled) this.locks.delete(file);
      return undefined;
    });
    return next;
  }

  private async readNow(file: string, cursor?: SessionCursor): Promise<ChatUpdateEx> {
    const cap = Math.max(1024, Math.floor(this.cap));
    let st = this.states.get(file);
    let rebuild = false;
    if (!st || !cursor || cursor.sessionFile !== file || cursor.offset !== st.offset) {
      st = { doc: new ChatDocument(), offset: 0, inode: "" };
      this.states.set(file, st);
      rebuild = true;
    }
    const prevLeaf = rebuild ? undefined : st.doc.leaf;
    let more = false;
    for (let round = 0; round < 8; round++) {
      const result = await this.readRound(file, st, cap);
      if (result.rebuilt) rebuild = true;
      if (result.again) continue;
      more = result.more;
      break;
    }
    await this.hydrateAncestors(file, st, cap);
    more ||= this.needsAncestors(st);
    const { items, pathIds } = st.doc.build();
    const reset = rebuild || (prevLeaf !== undefined && !pathIds.has(prevLeaf));
    return {
      cursor: { sessionFile: file, offset: st.offset },
      items,
      reset,
      more,
      truncated: st.doc.truncated,
    };
  }

  /**
   * One read after `st.offset`. `again`: a long line was skipped, read on after it; `more`: more
   * bytes are on the host; `rebuilt`: the file was read afresh over an existing document.
   */
  private async readRound(
    file: string,
    st: FileState,
    cap: number,
  ): Promise<{ again: boolean; more: boolean; rebuilt: boolean }> {
    const nonce = makeNonce();
    const out = await this.run(chatReadScript(file, st.offset, st.inode, cap, nonce));
    if (out.includes(`${nonce} MISSING`)) {
      this.states.delete(file);
      throw new HostError("not-found", `Session file not found: ${file}`);
    }
    const { header, body } = section(out, nonce);
    if (!header || header[0] !== "D" || header.length < 5)
      throw new HostError("command-failed", "Unexpected chat read output");
    const fresh = header[1] === "fresh";
    const size = Number(header[2]) || 0;
    const start = Number(header[4]) || 0;
    const rebuilt = fresh && (st.offset > 0 || st.doc.nodes.size > 0);
    if (fresh) {
      st.doc.reset();
      st.offset = 0;
      st.history = undefined;
    }
    st.inode = header[3] ?? "";
    const bytes = base64Decode(body);
    const capped = bytes.length >= (fresh ? cap : cap + 1);
    let pos = 0;
    if (start > 0) {
      const nl = bytes.indexOf(10);
      if (nl < 0) {
        // A fresh tail window entirely inside one line: skip to that line's end.
        st.doc.truncated = true;
        const again = await this.skipLongLine(file, st, start, false);
        if (fresh && again)
          st.history = { end: start, suffix: new Uint8Array(), length: st.offset - start };
        return { again, more: false, rebuilt };
      }
      pos = nl + 1;
      if (fresh) {
        st.doc.truncated = true;
        st.history = { end: start, suffix: bytes.slice(0, pos), length: pos };
      }
    }
    const firstLine = pos;
    pos = addLines(st.doc, bytes, pos);
    st.offset = start + pos;
    // One line longer than a read: a stub, then read on after it.
    if (pos === firstLine && capped)
      return { again: await this.skipLongLine(file, st, st.offset, true), more: false, rebuilt };
    return { again: false, more: capped && st.offset < size, rebuilt };
  }

  private needsAncestors(st: FileState): boolean {
    if (!st.history?.end) return false;
    const { nodes, broken } = st.doc.path();
    return broken && !nodes.some((node) => node.customType === "forge-side-boundary");
  }

  /** At most eight cap-sized backward windows per update; never change the selected leaf/cursor. */
  private async hydrateAncestors(file: string, st: FileState, cap: number): Promise<void> {
    for (let round = 0; round < 8 && this.needsAncestors(st); round++) {
      const history = st.history!;
      const nonce = makeNonce();
      const out = await this.run(chatReadScript(file, history.end, st.inode, cap, nonce, true));
      const { header, body } = section(out, nonce);
      const start = Number(header?.[4]);
      const bytes = base64Decode(body);
      if (!validBackRead(header, start, bytes.length, history.end, st, cap)) {
        // Do not merge ancestors from a replaced/shrunk file into the old branch.
        this.states.delete(file);
        throw new HostError("command-failed", "Session file changed during ancestor read");
      }
      const older = new ChatDocument();
      const mergeLine = (prefix: Uint8Array, suffix: Uint8Array, length: number) => {
        if (length > cap) {
          const node = stubEntry(utf8Decode(prefix), length);
          if (node) older.addNode(node);
        } else {
          const line = new Uint8Array(length);
          line.set(prefix);
          line.set(suffix, prefix.length);
          older.addLine(utf8Decode(line));
        }
      };
      const first = bytes.indexOf(10);
      const last = bytes.lastIndexOf(10);
      if (first < 0) {
        const length = bytes.length + history.length;
        if (start === 0) mergeLine(bytes, history.suffix, length);
        else if (length <= cap) {
          const suffix = new Uint8Array(length);
          suffix.set(bytes);
          suffix.set(history.suffix, bytes.length);
          history.suffix = suffix;
        } else history.suffix = new Uint8Array();
        history.length = length;
      } else {
        mergeLine(
          bytes.subarray(last + 1),
          history.suffix,
          bytes.length - last - 1 + history.length,
        );
        addLines(older, bytes.subarray(0, last + 1), first + 1);
        history.suffix = bytes.slice(0, first + 1);
        history.length = first + 1;
        if (start === 0) mergeLine(history.suffix, new Uint8Array(), history.length);
      }
      // Older nodes are context, not newly appended entries: addLine's leaf must not win.
      for (const [id, node] of older.nodes) if (!st.doc.nodes.has(id)) st.doc.nodes.set(id, node);
      history.end = start;
      if (start === 0) st.doc.truncated = false;
    }
  }

  /** Moves `st.offset` past the line at `position`, adding a stub when `stub`; false if it can't. */
  private async skipLongLine(
    file: string,
    st: FileState,
    position: number,
    stub: boolean,
  ): Promise<boolean> {
    const long = await this.longLine(file, position);
    if (!long || !long.complete) return false;
    if (stub) {
      const node = stubEntry(long.prefix, long.length);
      if (node) st.doc.addNode(node);
    }
    st.offset = position + long.length;
    return true;
  }

  private async longLine(
    file: string,
    position: number,
  ): Promise<{ length: number; complete: boolean; prefix: string } | undefined> {
    const nonce = makeNonce();
    const out = await this.run(longLineScript(file, position, 4096, nonce));
    const { header, body } = section(out, nonce);
    if (!header || header[0] !== "G") return undefined;
    const length = Number(header[1]) || 0;
    const size = Number(header[2]) || 0;
    const complete = header[3] === "1" && length > 0 && position + length <= size;
    return { length, complete, prefix: utf8Decode(base64Decode(body)) };
  }
}
