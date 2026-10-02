import { describe, expect, it } from "vitest";
import { RemoteError } from "@/remote/errors";
import { friendlyRemote, remoteDetail } from "./use-answers";

describe("remote error wording", () => {
  it("shows forge's reason only for refused/error, and never one about a terminal", () => {
    expect(remoteDetail(new RemoteError("refused", "the side is busy"))).toBe("the side is busy");
    expect(remoteDetail(new RemoteError("error", "disk full"))).toBe("disk full");
    expect(remoteDetail(new RemoteError("stale", "that dialog is closed"))).toBeUndefined();
    expect(
      remoteDetail(new RemoteError("refused", "a dialog or a panel has the terminal's input")),
    ).toBeUndefined();
    expect(remoteDetail(new RemoteError("refused", "use ask.answer"))).toBeUndefined();
    expect(remoteDetail(new RemoteError("refused", "  "))).toBeUndefined();
  });

  it("maps codes to their i18n keys, stale to Already answered", () => {
    expect(friendlyRemote(new RemoteError("stale"))).toEqual({ key: "pi.remote.errors.stale" });
    expect(new RemoteError("stale").friendly).toBe("Already answered");
    expect(friendlyRemote(new RemoteError("refused", "the side is busy"))).toEqual({
      key: "pi.remote.errors.refused",
      detail: "(the side is busy)",
    });
    expect(friendlyRemote(new Error("boom"))).toEqual({ key: "pi.remote.errors.transport" });
  });
});
