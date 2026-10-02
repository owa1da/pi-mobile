import { describe, expect, it } from "vitest";
import { shouldCollapseTerminalChrome, subBarStatus } from "./chrome";

describe("shouldCollapseTerminalChrome", () => {
  const phoneLandscape = { handheld: true, width: 914, height: 411 };
  const phonePortrait = { handheld: true, width: 411, height: 914 };

  it("collapses the terminal tab on a phone in landscape", () => {
    expect(shouldCollapseTerminalChrome({ tab: "terminal", ...phoneLandscape })).toBe(true);
  });

  it("never collapses the chat tab", () => {
    expect(shouldCollapseTerminalChrome({ tab: "chat", ...phoneLandscape })).toBe(false);
  });

  it("restores everything in portrait", () => {
    expect(shouldCollapseTerminalChrome({ tab: "terminal", ...phonePortrait })).toBe(false);
  });

  it("keeps chrome on tablets in landscape", () => {
    expect(
      shouldCollapseTerminalChrome({ tab: "terminal", handheld: false, width: 1280, height: 800 }),
    ).toBe(false);
  });

  it("does not collapse a square window", () => {
    expect(
      shouldCollapseTerminalChrome({ tab: "terminal", handheld: true, width: 500, height: 500 }),
    ).toBe(false);
  });
});

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
