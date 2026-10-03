import { describe, expect, it } from "vitest";
import {
  fitLine,
  footerDimmed,
  inputHeld,
  lineWidth,
  waitingBannerVisible,
  workingClock,
  workingRowVisible,
  type ChannelView,
  type LineKind,
} from "./chrome";
import type { RemoteState } from "@/remote/types";

describe("footerDimmed", () => {
  it("draws forge's line plainly while connected, dimmed otherwise (stale facts)", () => {
    expect(footerDimmed("connected")).toBe(false);
    for (const status of ["connecting", "reconnecting", "failed", "idle"] as const)
      expect(footerDimmed(status)).toBe(true);
  });
});

describe("inputHeld", () => {
  const base: RemoteState = {
    v: 1,
    pid: 1,
    sessionId: "s",
    rev: 1,
    updatedAt: 0,
    view: "main",
    draft: false,
  };
  const q = (blocking: boolean, status: "open" | "answered-unsent" = "open") => ({
    id: "q",
    blocking,
    askedAt: 0,
    status,
    items: [],
  });

  it("is held while pi's dialog or a blocking ask item has the input's place", () => {
    expect(inputHeld(undefined)).toBe(false);
    expect(inputHeld(base)).toBe(false);
    expect(
      inputHeld({
        ...base,
        view: "dialog",
        prompt: {
          id: "p",
          kind: "confirm",
          title: "Overwrite?",
          message: null,
          options: [],
          placeholder: null,
          prefill: null,
          answerable: true,
          held: false,
          since: 0,
        },
      }),
    ).toBe(true);
    expect(inputHeld({ ...base, questions: [q(true)] })).toBe(true);
  });

  it("is not held by a non-blocking or answered question (the composer stays)", () => {
    expect(inputHeld({ ...base, questions: [q(false)] })).toBe(false);
    expect(inputHeld({ ...base, questions: [q(true, "answered-unsent")] })).toBe(false);
  });
});

describe("workingRowVisible", () => {
  it("shows only while pi works, connected, and the input is not held", () => {
    expect(workingRowVisible("working", "connected", false)).toBe(true);
    expect(workingRowVisible("idle", "connected", false)).toBe(false);
    expect(workingRowVisible("waiting", "connected", false)).toBe(false);
    expect(workingRowVisible("working", "connected", true)).toBe(false);
    expect(workingRowVisible("working", "reconnecting", false)).toBe(false);
  });
});

describe("workingClock", () => {
  it("writes the run's clock as forge does", () => {
    expect(workingClock(0, 4_900)).toBe("4s");
    expect(workingClock(0, 74_000)).toBe("1m 14s");
    expect(workingClock(0, 120_000)).toBe("2m");
    expect(workingClock(0, 3_720_000)).toBe("1h 2m");
    expect(workingClock(10_000, 0)).toBe("0s");
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
  // Sonnet 5 · high · ctx 18%/200k · ~$0.126 · ◷ wakes in 30m (no state word: forge has none)
  const line = [
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
    expect(names(fitLine(line, room, SEP))).toEqual(["model", "context", "cost", "wake"]);
  });

  it("drops the model with its effort, then the cost, keeping context and items", () => {
    // context 80 + wake 100 + 1 sep = 190
    expect(names(fitLine(line, 200, SEP))).toEqual(["context", "wake"]);
  });

  it("never shows the effort without its model", () => {
    const fitted = fitLine(line, 300, SEP);
    expect(fitted.some((part) => part.kind === "thinking")).toBe(
      fitted.some((part) => part.kind === "model"),
    );
  });

  it("brings back a dropped part that fits again in the room left", () => {
    // Context goes before the items; with room for the wake item and the cost, cost comes back.
    expect(names(fitLine(line, 160, SEP))).toEqual(["cost", "wake"]);
  });

  it("drops the right-most item first", () => {
    const items = [p("context", 30), p("item", 50, "shell"), p("item", 100, "wake")];
    expect(names(fitLine(items, 95, SEP))).toEqual(["context", "shell"]);
  });

  it("keeps the most important part alone when nothing fits, for the caller to cut", () => {
    expect(names(fitLine(line, 10, SEP))).toEqual(["wake"]);
    expect(names(fitLine([p("model", 60), p("thinking", 30)], 10, SEP))).toEqual(["model"]);
  });
});
