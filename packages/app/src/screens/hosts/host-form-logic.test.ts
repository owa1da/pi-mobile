import { describe, expect, it } from "vitest";
import type { SavedHost } from "@/host/types";
import { modeOf, needsReconnect, resolveSecret, type SecretInput } from "./host-form-logic";

const base: SecretInput = {
  mode: "generate",
  existing: null,
  generated: null,
  pastedKey: "",
  passphrase: "",
  password: "",
};

describe("resolveSecret", () => {
  it("requires a secret when adding", () => {
    expect(resolveSecret(base)).toEqual({ ok: false });
    expect(resolveSecret({ ...base, mode: "paste" })).toEqual({ ok: false });
    expect(resolveSecret({ ...base, mode: "password" })).toEqual({ ok: false });
  });

  it("builds generated, pasted and password secrets", () => {
    const generated = { privateKey: "k", publicKey: "p" };
    expect(resolveSecret({ ...base, generated })).toEqual({
      ok: true,
      secret: { kind: "generated", privateKey: "k", publicKey: "p" },
    });
    expect(
      resolveSecret({ ...base, mode: "paste", pastedKey: "  KEY  ", passphrase: "pp" }),
    ).toEqual({
      ok: true,
      secret: { kind: "pasted", privateKey: "KEY\n", passphrase: "pp" },
    });
    expect(resolveSecret({ ...base, mode: "password", password: "pw" })).toEqual({
      ok: true,
      secret: { kind: "password", password: "pw" },
    });
  });

  it("keeps the saved secret when an edit leaves the fields empty", () => {
    expect(
      resolveSecret({ ...base, mode: "password", existing: { kind: "password", password: "x" } }),
    ).toEqual({ ok: true });
    const existing = { kind: "generated" as const, privateKey: "k", publicKey: "p" };
    expect(resolveSecret({ ...base, existing, generated: existing })).toEqual({ ok: true });
    expect(
      resolveSecret({
        ...base,
        mode: "paste",
        existing: { kind: "pasted", privateKey: "K" },
        passphrase: "new",
      }),
    ).toEqual({ ok: true, secret: { kind: "pasted", privateKey: "K", passphrase: "new" } });
    // switching method needs the new secret
    expect(
      resolveSecret({ ...base, mode: "paste", existing: { kind: "password", password: "x" } }),
    ).toEqual({ ok: false });
  });

  it("derives the mode from a saved secret", () => {
    expect(modeOf({ kind: "password", password: "x" }, "generate")).toBe("password");
    expect(modeOf(null, "paste")).toBe("paste");
  });
});

describe("needsReconnect", () => {
  const host = {
    id: "h",
    label: "Desk",
    host: "box",
    port: 22,
    username: "me",
    authType: "key",
    secretRef: "h",
    createdAt: 0,
  } satisfies SavedHost;
  const draft = { label: "Desk", host: "box", port: 22, username: "me" };

  it("only for address, user or secret changes", () => {
    expect(needsReconnect(host, { ...draft, label: "Renamed" }, false)).toBe(false);
    expect(needsReconnect(host, { ...draft, port: 2222 }, false)).toBe(true);
    expect(needsReconnect(host, { ...draft, username: "root" }, false)).toBe(true);
    expect(needsReconnect(host, draft, true)).toBe(true);
  });
});
