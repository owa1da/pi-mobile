import { describe, expect, it } from "vitest";
import {
  answerOf,
  draftAnswered,
  emptyDrafts,
  promptChoices,
  toggleOption,
  validateAskAnswers,
  validatePromptReply,
} from "./answers";
import {
  commandName,
  completeCommand,
  filterCommands,
  nativeTarget,
  matchCommand,
  refusalOutcome,
  slashQuery,
} from "./menu";
import { RemoteError, refusalReason } from "./errors";
import type { AskQuestion, RemotePrompt } from "./types";

const prompt = (over: Partial<RemotePrompt>): RemotePrompt => ({
  id: "p1",
  kind: "select",
  title: "Pick",
  message: null,
  options: ["Allow", "Deny"],
  placeholder: null,
  prefill: null,
  answerable: true,
  held: false,
  since: 0,
  ...over,
});

const ask: AskQuestion = {
  id: "q1",
  blocking: true,
  askedAt: 0,
  status: "open",
  items: [
    {
      question: "Which database?",
      header: "DB",
      multiSelect: false,
      options: [
        { label: "Postgres", description: null },
        { label: "SQLite", description: "file based" },
      ],
    },
    {
      question: "Which checks?",
      header: "Checks",
      multiSelect: true,
      options: [
        { label: "lint", description: null },
        { label: "types", description: null },
        { label: "tests", description: null },
      ],
    },
    { question: "Anything else?", header: null, multiSelect: false, options: [] },
  ],
};

describe("prompt answers", () => {
  it("offers the options, Yes/No for a bare confirm", () => {
    expect(promptChoices(prompt({}))).toEqual(["Allow", "Deny"]);
    expect(promptChoices(prompt({ kind: "confirm", options: null }))).toEqual(["Yes", "No"]);
    expect(promptChoices(prompt({ kind: "confirm", options: ["OK", "Stop"] }))).toEqual([
      "OK",
      "Stop",
    ]);
    expect(promptChoices(prompt({ kind: "input", options: null }))).toEqual([]);
  });

  it("accepts only an option for select/confirm, any text for input/editor, cancel for all", () => {
    expect(validatePromptReply(prompt({}), { value: "Allow" })).toEqual({
      ok: true,
      args: { id: "p1", value: "Allow" },
    });
    expect(validatePromptReply(prompt({}), { value: "allow" })).toEqual({
      ok: false,
      reason: "not-an-option",
    });
    expect(
      validatePromptReply(prompt({ kind: "confirm", options: null }), { value: "No" }).ok,
    ).toBe(true);
    expect(validatePromptReply(prompt({ kind: "editor", options: null }), { value: "" })).toEqual({
      ok: true,
      args: { id: "p1", value: "" },
    });
    expect(validatePromptReply(prompt({ kind: "input" }), { cancel: true })).toEqual({
      ok: true,
      args: { id: "p1", cancel: true },
    });
    expect(
      validatePromptReply(prompt({ kind: "custom", answerable: false }), { cancel: true }).ok,
    ).toBe(false);
  });
});

describe("ask_user answers", () => {
  it("single-select replaces and clears, multi-select toggles, unknown labels are ignored", () => {
    let one = emptyDrafts(ask)[0];
    one = toggleOption(ask.items[0], one, "Postgres");
    one = toggleOption(ask.items[0], one, "SQLite");
    expect(one.picked).toEqual(["SQLite"]);
    expect(toggleOption(ask.items[0], one, "SQLite").picked).toEqual([]);
    let multi = emptyDrafts(ask)[1];
    for (const label of ["tests", "lint", "nope"]) multi = toggleOption(ask.items[1], multi, label);
    expect(multi.picked).toEqual(["tests", "lint"]);
    multi = toggleOption(ask.items[1], multi, "tests");
    expect(multi.picked).toEqual(["lint"]);
  });

  it("builds one answer per question in option order, null for skipped, typed text kept", () => {
    const drafts = [
      { picked: ["SQLite"], typed: "" },
      { picked: ["tests", "lint"], typed: "  and e2e " },
      { picked: [], typed: "" },
    ];
    expect(validateAskAnswers(ask, drafts)).toEqual({
      ok: true,
      args: {
        id: "q1",
        answers: [{ picked: ["SQLite"] }, { picked: ["lint", "tests"], typed: "and e2e" }, null],
      },
    });
    expect(draftAnswered(drafts[1])).toBe(true);
    expect(draftAnswered(drafts[2])).toBe(false);
    expect(answerOf(ask.items[2], { picked: [], typed: "free text only" })).toEqual({
      picked: [],
      typed: "free text only",
    });
  });

  it("refuses an all-skipped item, a closed item and stray labels", () => {
    expect(validateAskAnswers(ask, emptyDrafts(ask))).toEqual({
      ok: false,
      reason: "nothing-answered",
    });
    expect(
      validateAskAnswers({ ...ask, status: "answered-unsent" }, [{ picked: ["SQLite"], typed: "" }])
        .ok,
    ).toBe(false);
    // answerOf drops labels that are not options, so a stray label alone means nothing answered.
    expect(validateAskAnswers(ask, [{ picked: ["MySQL"], typed: "" }]).ok).toBe(false);
  });
});

describe("the / menu", () => {
  const commands = [
    { name: "compact", description: "Compact the context" },
    { name: "model", description: "Pick a model" },
    { name: "rewind", description: "Rewind" },
    { name: "commit", description: null },
    { name: "recompile", description: null },
  ];

  it("opens on a leading / until the first space", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/co")).toBe("co");
    expect(slashQuery("/compact now")).toBeUndefined();
    expect(slashQuery(" /co")).toBeUndefined();
    expect(slashQuery("hello")).toBeUndefined();
  });

  it("filters prefix matches first, then substrings, case-insensitively", () => {
    expect(filterCommands(commands, "").map((c) => c.name)).toEqual(commands.map((c) => c.name));
    expect(filterCommands(commands, "CO").map((c) => c.name)).toEqual([
      "compact",
      "commit",
      "recompile",
    ]);
    expect(filterCommands(commands, "zzz")).toEqual([]);
  });

  it("completes a row and matches a sent line to a row", () => {
    expect(completeCommand(commands[0])).toBe("/compact ");
    expect(commandName("/compact keep the plan")).toBe("compact");
    expect(matchCommand("/model", commands)?.name).toBe("model");
    expect(matchCommand("/unknown thing", commands)).toBeUndefined();
    expect(matchCommand("/model", undefined)).toBeUndefined();
    expect(matchCommand("not a command", commands)).toBeUndefined();
  });

  it("opens the CLI's names in their native screens, with the words after the name", () => {
    expect(nativeTarget("/rewind")).toEqual({ tool: "rewind", name: "rewind", arg: "" });
    expect(nativeTarget("/diff")?.tool).toBe("checkpoints");
    expect(nativeTarget("/restore 3")).toEqual({ tool: "checkpoints", name: "restore", arg: "3" });
    expect(nativeTarget("/thinking")?.tool).toBe("model");
    expect(nativeTarget("/rename  Fix login ")).toEqual({
      tool: "rename",
      name: "rename",
      arg: "Fix login",
    });
    expect(nativeTarget("/btw what is a token bucket?")?.arg).toBe("what is a token bucket?");
    for (const name of [
      "side",
      "tasks",
      "usage",
      "cost",
      "changelog",
      "pause",
      "export",
      "branch",
      "clear",
      "sync",
    ])
      expect(nativeTarget(`/${name}`)?.tool).toBeDefined();
    expect(nativeTarget("/mcp")).toBeUndefined();
    expect(nativeTarget("/compact")).toBeUndefined();
    expect(nativeTarget("hello")).toBeUndefined();
  });

  it("sends skills as messages, never through command.run", () => {
    const rows = [...commands, { name: "skill:review", description: null }];
    expect(matchCommand("/skill:review the diff", rows)).toBeUndefined();
  });

  it("classifies refusals by data.reason, whatever the message says", () => {
    expect(refusalOutcome("plan", "anything", "template")).toEqual({ kind: "paste" });
    expect(refusalOutcome("review", null, "skill")).toEqual({ kind: "paste" });
    expect(refusalOutcome("settings", "reworded", "tui-only")).toEqual({
      kind: "notice",
      key: "pi.remote.computerOnly",
      params: { name: "settings" },
      testID: "command-computer-only",
    });
    expect(refusalOutcome("answer", null, "tui-only")).toMatchObject({
      key: "pi.remote.answerHere",
    });
    expect(refusalOutcome("compact", "starts a turn", "busy")).toMatchObject({
      key: "pi.remote.inputBusy",
    });
    expect(refusalOutcome("compact", null, "not-main")).toMatchObject({ key: "pi.remote.notMain" });
    expect(refusalOutcome("compact", null, "gate")).toMatchObject({ key: "pi.remote.notMain" });
    expect(refusalOutcome("compact", null, "not-answerable")).toEqual({ kind: "error" });
  });

  it("falls back to the message text only for forge builds without a reason", () => {
    expect(refusalOutcome("plan", "/plan starts a turn: send it as a message")).toEqual({
      kind: "paste",
    });
    expect(
      refusalOutcome(
        "settings",
        "/settings opens a terminal view: pi's settings are terminal-only",
      ),
    ).toMatchObject({ key: "pi.remote.computerOnly", params: { name: "settings" } });
    expect(refusalOutcome("answer", "/answer opens a terminal view: use ask.answer")).toMatchObject(
      { key: "pi.remote.answerHere" },
    );
    expect(refusalOutcome("compact", "a dialog or a panel has the terminal's input")).toMatchObject(
      { kind: "notice", key: "pi.remote.inputBusy" },
    );
    expect(refusalOutcome("compact", "/compact is not in the / menu")).toEqual({ kind: "error" });
    expect(refusalOutcome("compact", null)).toEqual({ kind: "error" });
  });

  it("reads data.reason off a refused result only", () => {
    const refused = new RemoteError("refused", "x", {
      v: 1,
      nonce: "n",
      ok: false,
      code: "refused",
      message: "x",
      data: { reason: "busy" },
      at: 0,
    });
    expect(refused.reason).toBe("busy");
    expect(refusalReason({ reason: "made-up" })).toBeUndefined();
    expect(refusalReason(null)).toBeUndefined();
    expect(new RemoteError("error", "x").reason).toBeUndefined();
  });
});
