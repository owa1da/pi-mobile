import { describe, expect, it } from "vitest";
import { decideHostKey, splitFingerprint } from "./tofu";

const A = "SHA256:aaaa";
const B = "SHA256:bbbb";

describe("decideHostKey", () => {
  it("accepts the pinned key", () => {
    expect(decideHostKey({ pinned: A, presented: A, interactive: false })).toEqual({
      action: "accept",
    });
  });

  it("asks on first use when a person is present", () => {
    expect(decideHostKey({ pinned: undefined, presented: A, interactive: true })).toEqual({
      action: "ask",
    });
  });

  it("refuses an unknown key on an unattended reconnect", () => {
    expect(decideHostKey({ pinned: undefined, presented: A, interactive: false })).toEqual({
      action: "refuse",
      reason: "unattended-unknown",
    });
  });

  it("refuses a changed key", () => {
    expect(decideHostKey({ pinned: A, presented: B, interactive: true })).toEqual({
      action: "refuse",
      reason: "mismatch",
    });
  });

  it("replaces only the exact key the user approved, and only interactively", () => {
    expect(decideHostKey({ pinned: A, presented: B, interactive: true, replaceWith: B })).toEqual({
      action: "replace",
    });
    expect(
      decideHostKey({ pinned: A, presented: "SHA256:cccc", interactive: true, replaceWith: B }),
    ).toEqual({ action: "refuse", reason: "mismatch" });
    expect(decideHostKey({ pinned: A, presented: B, interactive: false, replaceWith: B })).toEqual({
      action: "refuse",
      reason: "mismatch",
    });
  });

  it("splits fingerprints for display", () => {
    expect(splitFingerprint("SHA256:abc/+def")).toEqual({ prefix: "SHA256", digest: "abc/+def" });
    expect(splitFingerprint("abc")).toEqual({ prefix: "", digest: "abc" });
  });
});
