import { describe, expect, it } from "vitest";
import {
  fitLine,
  lineWidth,
  subBarStatus,
  waitingBannerVisible,
  type ChannelView,
  type LineKind,
} from "./chrome";
import type { RemoteState } from "@/remote/types";

describe("subBarStatus", () => {
  it("shows the session state while connected", () => {
    expect(subBarStatus("connected", "idle")).toEqual({
      kind: "state",
      key: "pi.session.state.idle",
    });
    expect(subBarStatus("connected", "waiting")).toMatchObject({ key: "pi.session.state.waiting" });
  });

  it("names the connection instead of a stale state", () => {
    expect(subBarStatus("connecting", "working")).toEqual({
      kind: "connection",
      key: "pi.session.connection.connecting",
    });
    expect(subBarStatus("idle", "idle")).toEqual({
      kind: "connection",
      key: "pi.session.connection.offline",
    });
  });

  it("stays quiet while the connection banner already says it", () => {
    expect(subBarStatus("reconnecting", "idle")).toEqual({ kind: "quiet" });
    expect(subBarStatus("failed", "working", true)).toEqual({ kind: "quiet" });
  });

  it("says Sending while an optimistic send is in flight, then the real state", () => {
    expect(subBarStatus("connected", "idle", true)).toEqual({
      kind: "pending",
      key: "pi.session.state.sending",
    });
    expect(subBarStatus("connected", "working", true)).toMatchObject({
      key: "pi.session.state.working",
    });
    expect(subBarStatus("connected", "waiting", true)).toMatchObject({
      key: "pi.session.state.waiting",
    });
    expect(subBarStatus("connected", "idle", false)).toMatchObject({
      key: "pi.session.state.idle",
    });
  });
});

describe("waitingBannerVisible", () => {
  const base: RemoteState = {
    v: 1,
    pid: 1,
    sessionId: "s",
    rev: 1,
    updatedAt: 0,
    view: "main",
    draft: false,
  };
  const ch = (state: RemoteState | undefined, extra: Partial<ChannelView> = {}): ChannelView => ({
    available: true,
    loaded: true,
    state,
    ...extra,
  });
  const prompt = {
    id: "p1",
    kind: "select" as const,
    title: "Allow?",
    message: null,
    options: ["Allow"],
    placeholder: null,
    prefill: null,
    answerable: true,
    held: false,
    since: 0,
  };

  it("never shows unless the row is waiting", () => {
    expect(waitingBannerVisible("idle", ch(undefined, { available: false }))).toBe(false);
  });

  it("shows for sessions without a channel or with an unreadable state", () => {
    expect(waitingBannerVisible("waiting", ch(undefined, { available: false }))).toBe(true);
    expect(waitingBannerVisible("waiting", ch(undefined))).toBe(true);
  });

  it("stays hidden while the channel loads, and while the dock shows a dialog or question", () => {
    expect(waitingBannerVisible("waiting", ch(undefined, { loaded: false }))).toBe(false);
    expect(waitingBannerVisible("waiting", ch({ ...base, view: "dialog", prompt }))).toBe(false);
    const q = { id: "q", blocking: true, askedAt: 0, status: "open" as const, items: [] };
    expect(waitingBannerVisible("waiting", ch({ ...base, questions: [q] }))).toBe(false);
  });

  it("trusts the loaded channel over a lagging listing right after an answer", () => {
    expect(waitingBannerVisible("waiting", ch({ ...base, view: "main", prompt: null }))).toBe(
      false,
    );
  });

  it("shows when the channel says a dialog is up that it does not describe", () => {
    expect(waitingBannerVisible("waiting", ch({ ...base, view: "dialog", prompt: null }))).toBe(
      true,
    );
  });
});

describe("fitLine (forge's LINE_DROP_ORDER)", () => {
  const p = (kind: LineKind, width: number, name: string = kind) => ({ kind, width, name });
  const names = (parts: { name: string }[]) => parts.map((part) => part.name);
  // Idle · Sonnet 5 · high · ctx 18%/200k · ~$0.126 · ◷ wakes in 30m
  const line = [
    p("state", 30),
    p("model", 60),
    p("thinking", 30),
    p("context", 80),
    p("cost", 50),
    p("item", 100, "wake"),
  ];
  const SEP = 10;

  it("keeps every part when the line fits", () => {
    expect(names(fitLine(line, lineWidth(line, SEP), SEP))).toEqual(names(line));
  });

  it("drops the effort first, whole, before any item is cut", () => {
    const room = lineWidth(line, SEP) - 20;
    expect(names(fitLine(line, room, SEP))).toEqual(["state", "model", "context", "cost", "wake"]);
  });

  it("drops the model with its effort, then the cost, keeping context and items", () => {
    // state 30 + context 80 + wake 100 + 2 seps = 230
    expect(names(fitLine(line, 240, SEP))).toEqual(["state", "context", "wake"]);
  });

  it("never shows the effort without its model", () => {
    const fitted = fitLine(line, 300, SEP);
    expect(fitted.some((part) => part.kind === "thinking")).toBe(
      fitted.some((part) => part.kind === "model"),
    );
  });

  it("brings back a dropped part that fits again in the room left", () => {
    // Items go before the state; with room for state + cost only, cost comes back.
    expect(names(fitLine(line, 90, SEP))).toEqual(["state", "cost"]);
  });

  it("drops the right-most item first", () => {
    const items = [p("state", 30), p("item", 50, "shell"), p("item", 100, "wake")];
    expect(names(fitLine(items, 95, SEP))).toEqual(["state", "shell"]);
  });

  it("keeps the most important part alone when nothing fits, for the caller to cut", () => {
    expect(names(fitLine(line, 10, SEP))).toEqual(["state"]);
    expect(names(fitLine([p("model", 60), p("thinking", 30)], 10, SEP))).toEqual(["model"]);
  });
});
