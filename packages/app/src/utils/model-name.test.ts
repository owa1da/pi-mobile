import { describe, expect, it } from "vitest";
import { modelName, nameFromId, plainLine, shortModelId } from "./model-name";

describe("plainLine", () => {
  it("drops CSI/OSC escapes and control characters and folds whitespace", () => {
    expect(plainLine("\u001b[1;31mOpus\u001b[0m  5.5\n")).toBe("Opus 5.5");
    expect(plainLine("\u001b]8;;https://x\u0007link\u001b]8;;\u001b\\ text")).toBe("link text");
    expect(plainLine("a\tb\u0000c\u009bd")).toBe("a b c d");
    expect(plainLine(undefined)).toBe("");
    expect(plainLine(null)).toBe("");
    expect(plainLine(42)).toBe("42");
  });
});

describe("shortModelId", () => {
  it("keeps the id after the last slash", () => {
    expect(shortModelId("openrouter/z-ai/glm-5.3-flash")).toBe("glm-5.3-flash");
    expect(shortModelId("glm-5.3-flash")).toBe("glm-5.3-flash");
  });
});

describe("nameFromId", () => {
  it("reads an id as capitalised words with single digits joined by a dot", () => {
    expect(nameFromId("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(nameFromId("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(nameFromId("deepseek-v4-flash")).toBe("Deepseek V4 Flash");
    expect(nameFromId("glm-5.3-flash")).toBe("GLM 5.3 Flash");
    expect(nameFromId("openrouter/z-ai/glm-5.3-flash")).toBe("GLM 5.3 Flash");
  });

  it("joins only single digits onto a number ending in a single digit", () => {
    expect(nameFromId("gpt-5-1")).toBe("GPT 5.1");
    expect(nameFromId("claude-3-5-haiku-20241022")).toBe("Claude 3.5 Haiku 20241022");
    expect(nameFromId("model-2024-1")).toBe("Model 2024 1");
    expect(nameFromId("fake-1")).toBe("Fake 1");
    expect(nameFromId("qwen3_coder:30b")).toBe("Qwen3 Coder 30b");
  });
});

describe("modelName", () => {
  it("strips a vendor prefix and a leading Claude from a display name", () => {
    expect(modelName({ id: "x", name: "Anthropic: Claude Sonnet 4.6" })).toBe("Sonnet 4.6");
    expect(modelName({ id: "x", name: "Z.ai: GLM 5.3 Flash" })).toBe("GLM 5.3 Flash");
    expect(modelName({ id: "x", name: "Claude Fable 5.1" })).toBe("Fable 5.1");
    expect(modelName({ id: "x", name: "GLM 5.3 Flash" })).toBe("GLM 5.3 Flash");
  });

  it("keeps Claude before a number (no name follows)", () => {
    expect(modelName({ id: "x", name: "Claude 3 Haiku" })).toBe("Claude 3 Haiku");
  });

  it("derives the name from the id when name is missing, empty or equal to the id", () => {
    expect(modelName({ id: "claude-opus-5-5" })).toBe("Opus 5.5");
    expect(modelName({ id: "claude-opus-5-5", name: "" })).toBe("Opus 5.5");
    expect(modelName({ id: "claude-opus-5-5", name: null })).toBe("Opus 5.5");
    expect(modelName({ id: "glm-5.3-flash", name: "glm-5.3-flash" })).toBe("GLM 5.3 Flash");
    expect(modelName({ id: "anthropic/claude-sonnet-4-6" })).toBe("Sonnet 4.6");
  });

  it("treats a bare string as an id and empty input as no name", () => {
    expect(modelName("openrouter/z-ai/glm-5.3-flash")).toBe("GLM 5.3 Flash");
    expect(modelName(undefined)).toBe("");
    expect(modelName(null)).toBe("");
    expect(modelName({ id: "" })).toBe("");
  });

  it("does not treat a long colon-led sentence as a vendor prefix", () => {
    const long = "A very long vendor name over thirty chars: Model";
    expect(modelName({ id: "x", name: long })).toBe(long);
  });
});
