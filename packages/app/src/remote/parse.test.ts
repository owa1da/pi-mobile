import { describe, expect, it } from "vitest";
import { openQuestions, parseRemoteResult, parseRemoteState } from "./parse";

const base = { v: 1, pid: 123, sessionId: "s1", rev: 4, updatedAt: 1790000000000, view: "main" };

describe("parseRemoteState: the contract's state.json", () => {
  it("parses every area of a full state", () => {
    const state = parseRemoteState(
      JSON.stringify({
        ...base,
        draft: true,
        prompt: {
          id: "p1",
          kind: "select",
          title: "Allow bash?",
          message: "line one\nline two",
          options: ["Allow", "Deny"],
          placeholder: null,
          prefill: null,
          answerable: true,
          held: false,
          since: 5,
        },
        questions: [
          {
            id: "q1",
            blocking: true,
            askedAt: 1,
            status: "open",
            items: [
              {
                question: "Which db?",
                header: "DB",
                multiSelect: false,
                options: [{ label: "pg", description: "Postgres" }],
              },
            ],
          },
        ],
        footer: {
          model: {
            provider: "anthropic",
            id: "claude-opus-5-5",
            name: "Opus 5.5",
            thinking: "high",
          },
          contextPercent: 12,
          contextTokens: 24000,
          contextWindow: 200000,
          cost: 0.42,
        },
        wake: null,
        side: null,
        tasks: [],
        checkpoints: [],
        commands: [{ name: "compact", description: "Compact the context" }],
        pins: { pinned: ["a/b"], recent: [] },
        extra: "ignored",
      }),
      123,
    );
    expect(state).toMatchObject({
      v: 1,
      pid: 123,
      rev: 4,
      draft: true,
      view: "main",
      wake: null,
      side: null,
      tasks: [],
      checkpoints: [],
      pins: { pinned: ["a/b"], recent: [] },
    });
    expect(state?.prompt).toMatchObject({
      id: "p1",
      kind: "select",
      message: "line one\nline two",
      options: ["Allow", "Deny"],
      answerable: true,
    });
    expect(state?.questions?.[0].items[0]).toEqual({
      question: "Which db?",
      header: "DB",
      multiSelect: false,
      options: [{ label: "pg", description: "Postgres" }],
    });
    expect(state?.footer?.model?.name).toBe("Opus 5.5");
    expect(state?.commands).toEqual([{ name: "compact", description: "Compact the context" }]);
    expect(state).not.toHaveProperty("extra");
  });

  it("leaves absent areas undefined (screens hidden) and keeps null as no dialog", () => {
    const state = parseRemoteState({ ...base, prompt: null });
    expect(state?.prompt).toBeNull();
    for (const area of [
      "questions",
      "footer",
      "wake",
      "side",
      "tasks",
      "checkpoints",
      "commands",
      "pins",
    ])
      expect(state).not.toHaveProperty(area);
    expect(parseRemoteState(base)).not.toHaveProperty("prompt");
  });

  it("accepts native input readiness only with a positive integer byte bound", () => {
    expect(parseRemoteState({ ...base, input: { submit: true, maxBytes: 61440 } })?.input).toEqual({
      submit: true,
      maxBytes: 61440,
    });
    expect(
      parseRemoteState({ ...base, input: { submit: false, maxBytes: 61440 } })?.input?.submit,
    ).toBe(false);
    for (const input of [
      null,
      {},
      { submit: "true", maxBytes: 61440 },
      { submit: true, maxBytes: -1 },
      { submit: true, maxBytes: 1.5 },
    ])
      expect(parseRemoteState({ ...base, input })?.input).toBeUndefined();
  });

  it("keeps side ownership during startup without a session file", () => {
    expect(
      parseRemoteState({
        ...base,
        side: { id: "startup", gen: 1, open: true, working: true, sessionFile: null },
      })?.side,
    ).toEqual({ id: "startup", gen: 1, open: true, working: true, sessionFile: null });
  });
  it("keeps legacy sides without inventing ownership", () => {
    const side = { open: false, working: false, sessionFile: "/legacy" };
    expect(parseRemoteState({ ...base, side })?.side).toEqual(side);
  });
  it("drops malformed ownership fields", () => {
    for (const gen of [-1, 1.5, "1", Infinity]) {
      const side = parseRemoteState({ ...base, side: { id: "", gen } })?.side;
      expect(side).not.toHaveProperty("id");
      expect(side).not.toHaveProperty("gen");
    }
  });

  it("rejects malformed, partial, other-version and other-process files", () => {
    expect(parseRemoteState('{"v":1,"pid":12')).toBeUndefined();
    expect(parseRemoteState("[]")).toBeUndefined();
    expect(parseRemoteState({ ...base, v: 2 })).toBeUndefined();
    expect(parseRemoteState({ ...base, pid: "123" })).toBeUndefined();
    expect(parseRemoteState({ ...base, pid: -1 })).toBeUndefined();
    expect(parseRemoteState(base, 999)).toBeUndefined();
    expect(parseRemoteState(null)).toBeUndefined();
  });

  it("drops a malformed area on its own", () => {
    const state = parseRemoteState({
      ...base,
      prompt: { id: "p", kind: "weird", title: "x" },
      questions: [{ id: "bad" }, { id: "q", items: [{ question: "ok?", options: ["a", "a", 3] }] }],
      commands: [{ name: "ok" }, { name: "has space" }, { name: "/slash" }, 7],
      footer: "nope",
      tasks: [{ owner: "o", key: "k", kind: "shell", name: "n" }, { kind: "nope" }],
    });
    expect(state?.prompt).toBeNull();
    expect(state?.questions).toHaveLength(1);
    expect(state?.questions?.[0].items[0].options).toEqual([{ label: "a", description: null }]);
    expect(state?.commands?.map((c) => c.name)).toEqual(["ok", "slash"]);
    expect(state?.footer).toBeNull();
    expect(state?.tasks).toHaveLength(1);
  });

  it("drops an ask set whose item is malformed (answers would shift onto the wrong question)", () => {
    const state = parseRemoteState({
      ...base,
      questions: [{ id: "q", items: [{ question: "one" }, { header: "no question" }] }],
    });
    expect(state?.questions).toEqual([]);
  });

  it("caps text and options, and strips control characters", () => {
    const long = "x".repeat(900);
    const state = parseRemoteState({
      ...base,
      prompt: {
        id: "p",
        kind: "select",
        title: `\u001b[31m${long}`,
        message: "a\u0007b\r\nc",
        options: Array.from({ length: 80 }, (_, i) => `o${i}${"y".repeat(300)}`),
        answerable: true,
      },
    });
    expect(Array.from(state?.prompt?.title ?? "").length).toBeLessThanOrEqual(500);
    expect(state?.prompt?.title.startsWith("x")).toBe(true);
    expect(state?.prompt?.message).toBe("ab\nc");
    expect(state?.prompt?.options).toHaveLength(50);
    expect(Array.from(state?.prompt?.options?.[0] ?? "").length).toBeLessThanOrEqual(200);
  });

  it("never treats a custom dialog or an empty select as answerable", () => {
    const custom = parseRemoteState({
      ...base,
      prompt: { id: "c", kind: "custom", title: "MCP servers", answerable: true },
    });
    expect(custom?.prompt?.answerable).toBe(false);
    const empty = parseRemoteState({
      ...base,
      prompt: { id: "s", kind: "select", title: "Pick", options: [], answerable: true },
    });
    expect(empty?.prompt?.answerable).toBe(false);
  });

  it("orders open questions blocking first, then oldest; answered-unsent are not open", () => {
    const state = parseRemoteState({
      ...base,
      questions: [
        { id: "a", blocking: false, askedAt: 1, items: [{ question: "a?" }] },
        { id: "b", blocking: true, askedAt: 3, items: [{ question: "b?" }] },
        { id: "c", blocking: true, askedAt: 2, items: [{ question: "c?" }] },
        {
          id: "d",
          status: "answered-unsent",
          blocking: true,
          askedAt: 0,
          items: [{ question: "d?" }],
        },
      ],
    });
    expect(openQuestions(state).map((q) => q.id)).toEqual(["c", "b", "a"]);
  });
});

describe("parseRemoteResult", () => {
  it("reads a result for its nonce", () => {
    const r = parseRemoteResult(
      '{"v":1,"nonce":"n1","ok":true,"code":"ok","message":null,"data":{"x":1},"at":5}',
      "n1",
    );
    expect(r).toEqual({
      v: 1,
      nonce: "n1",
      ok: true,
      code: "ok",
      message: null,
      data: { x: 1 },
      at: 5,
    });
  });

  it("rejects another nonce and reads unknown or contradictory codes as errors", () => {
    expect(parseRemoteResult({ nonce: "n2", ok: true, code: "ok" }, "n1")).toBeUndefined();
    expect(parseRemoteResult({ nonce: "n", ok: false, code: "weird" })?.code).toBe("error");
    expect(parseRemoteResult({ nonce: "n", ok: false, code: "ok" })).toMatchObject({
      ok: false,
      code: "error",
    });
    expect(parseRemoteResult({ nonce: "n", ok: true, code: "stale" })).toMatchObject({
      ok: false,
      code: "stale",
    });
  });
});
