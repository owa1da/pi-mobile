import { describe, expect, it } from "vitest";

import { DRAFT_MESSAGE, HostOutcomeUnknownError, PaneBusyError } from "@/host/errors";
import { HostError } from "@/host/types";
import { en } from "@/i18n/resources/en";
import { RemoteError } from "@/remote/errors";

import { friendlyHostError } from "./send-errors";

function lookup(key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node && typeof node === "object") return (node as Record<string, unknown>)[part];
    return undefined;
  }, en);
}

describe("friendlyHostError", () => {
  it("explains missing native capability without claiming a desktop draft blocks sending", () => {
    const friendly = friendlyHostError(new PaneBusyError("draft", DRAFT_MESSAGE));
    expect(friendly).toEqual({ key: "pi.session.errors.pane-busy-draft" });
    expect(lookup(friendly.key)).toBe(DRAFT_MESSAGE);
    expect(DRAFT_MESSAGE).not.toMatch(/terminal|unsent draft|send or clear/i);
  });

  it("tells copy mode and a missing prompt apart", () => {
    expect(friendlyHostError(new PaneBusyError("copy-mode", "x")).key).toBe(
      "pi.session.errors.pane-busy",
    );
    expect(friendlyHostError(new PaneBusyError("no-prompt", "x"))).toMatchObject({
      key: "pi.session.errors.pane-busy-no-prompt",
    });
  });

  it("marks a timed-out send as outcome unknown (never resent)", () => {
    const friendly = friendlyHostError(new HostOutcomeUnknownError("timed out"));
    expect(friendly).toMatchObject({
      key: "pi.session.errors.outcome-unknown",
      outcomeUnknown: true,
    });
    expect(typeof lookup(friendly.key)).toBe("string");
  });

  it.each(["invalid", "stale"] as const)(
    "uses calm command copy for %s, without raw channel details",
    (code) => {
      const friendly = friendlyHostError(new RemoteError(code, "command.run details"));
      expect(friendly.detail).toBeUndefined();
      expect(typeof lookup(friendly.key)).toBe("string");
      expect(lookup(friendly.key)).not.toMatch(/answer|terminal|command\.run/);
    },
  );

  it("explains a missing tmux", () => {
    expect(friendlyHostError(new HostError("tmux-missing", "tmux is not installed")).key).toBe(
      "pi.session.errors.tmux-missing",
    );
  });
});
