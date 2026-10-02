import { describe, expect, it } from "vitest";
import { subBarStatus, waitingBannerVisible, type ChannelView } from "./chrome";
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
