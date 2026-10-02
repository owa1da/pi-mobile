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
    expect(subBarStatus("connected", "waiting").key).toBe("pi.session.state.waiting");
  });

  it("names the connection instead of a stale state", () => {
    expect(subBarStatus("reconnecting", "idle").key).toBe("pi.session.connection.reconnecting");
    expect(subBarStatus("connecting", "working").key).toBe("pi.session.connection.connecting");
    expect(subBarStatus("failed", "idle").key).toBe("pi.session.connection.offline");
    expect(subBarStatus("idle", "idle").kind).toBe("connection");
  });
});
