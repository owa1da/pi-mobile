import { describe, expect, it } from "vitest";
import {
  connectionAnnouncement,
  latestReply,
  nextReplyAnnouncement,
  previewText,
} from "./announce";
import type { ChatRow } from "./chat-rows";

const user = (key: string): ChatRow => ({
  kind: "user",
  key,
  text: "hi",
  timestamp: 0,
  pending: false,
});
const reply = (key: string, phase: "complete" | "streaming" = "complete"): ChatRow => ({
  kind: "assistant",
  key,
  text: `reply ${key}`,
  timestamp: 0,
  phase,
});

describe("latestReply", () => {
  it("finds the newest complete assistant row", () => {
    expect(latestReply([user("u"), reply("a"), user("v")])).toEqual({ key: "a", text: "reply a" });
  });
  it("is null while the newest reply is still streaming", () => {
    expect(latestReply([reply("a"), reply("b", "streaming")])).toBeNull();
  });
  it("is null with no assistant row", () => {
    expect(latestReply([user("u")])).toBeNull();
  });
});

describe("nextReplyAnnouncement", () => {
  it("takes the first reply as the baseline without announcing it", () => {
    expect(nextReplyAnnouncement(undefined, { key: "a", text: "x" }, false)).toEqual({
      baseline: "a",
      announce: null,
    });
  });
  it("announces a new reply once", () => {
    const first = nextReplyAnnouncement("a", { key: "b", text: "x" }, false);
    expect(first.announce?.key).toBe("b");
    expect(nextReplyAnnouncement(first.baseline, { key: "b", text: "x" }, false).announce).toBe(
      null,
    );
  });
  it("stays quiet while pi is working (intermediate tool steps)", () => {
    expect(nextReplyAnnouncement("a", { key: "b", text: "x" }, true)).toEqual({
      baseline: "a",
      announce: null,
    });
  });
});

describe("previewText", () => {
  it("drops markdown marks and code blocks and folds whitespace", () => {
    expect(previewText("## Done\n\n**All** `tests` pass\n```ts\nx\n```")).toBe(
      "Done All tests pass",
    );
  });
  it("cuts long text at a word with an ellipsis", () => {
    const out = previewText("word ".repeat(60), 30);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(31);
  });
});

describe("connectionAnnouncement", () => {
  it("announces a drop, a failure and a recovery once each", () => {
    expect(connectionAnnouncement("connected", "reconnecting")).toBe("reconnecting");
    expect(connectionAnnouncement("reconnecting", "reconnecting")).toBeNull();
    expect(connectionAnnouncement("reconnecting", "failed")).toBe("failed");
    expect(connectionAnnouncement("reconnecting", "connected")).toBe("restored");
  });
  it("never announces a first connect", () => {
    expect(connectionAnnouncement("other", "connected")).toBeNull();
  });
});
