import { describe, expect, it } from "vitest";
import { base64Decode, utf8Decode } from "@/host/encoding";
import { createRemoteClient, hasRemote } from "./client";
import { REMOTE_ERROR_KEYS, RemoteError, errorFromResult } from "./errors";
import { hostSkewMs } from "./for-service";
import type { RemoteResult, ResultCode } from "./types";

const ROW = { pid: 42, live: true, remote: 1 };

function tagOf(script: string): string {
  return /printf '%s [A-Z]+\\n' ([A-Za-z0-9_-]+)/.exec(script)?.[1] ?? "";
}

/** A fake host: `respond(script, call)` returns stdout for each exec. */
function fakeClient(respond: (script: string, call: number) => string, extra = {}) {
  const scripts: string[] = [];
  let n = 0;
  const client = createRemoteClient({
    run: async (script) => {
      scripts.push(script);
      return respond(script, scripts.length - 1);
    },
    agentDir: async () => "/h/.pi/agent",
    now: () => 1_790_000_000_000,
    sleep: async () => undefined,
    nonce: () => `pimnonce${String(n++).padStart(4, "0")}`,
    ...extra,
  });
  return { client, scripts };
}

const result = (nonce: string, code: ResultCode, message: string | null = null) =>
  JSON.stringify({ v: 1, nonce, ok: code === "ok", code, message, data: null, at: 1 });

describe("remote client", () => {
  it("only talks to live rows whose record says remote: 1", async () => {
    expect(hasRemote(ROW)).toBe(true);
    expect(hasRemote({ ...ROW, remote: undefined })).toBe(false);
    expect(hasRemote({ ...ROW, remote: 2 })).toBe(false);
    expect(hasRemote({ ...ROW, live: false })).toBe(false);
    const { client, scripts } = fakeClient(() => "");
    expect(await client.readState({ ...ROW, remote: undefined })).toBeUndefined();
    await expect(
      client.send({ ...ROW, remote: undefined }, "ask.dismiss", { id: "q" }),
    ).rejects.toMatchObject({ code: "no-channel" });
    expect(scripts).toHaveLength(0);
  });

  it("writes the action as base64 JSON and returns the ok result found by the first exec", async () => {
    const { client, scripts } = fakeClient((script) => {
      const tag = tagOf(script);
      return `${tag} SENT\n${tag} RESULT\n${result("pimnonce0000", "ok")}\n${tag} END\n`;
    });
    const r = await client.send(ROW, "prompt.respond", { id: "p1", value: "Allow" }, { rev: 3 });
    expect(r.ok).toBe(true);
    const b64 = /B64='([^']*)'/.exec(scripts[0])?.[1] ?? "";
    expect(JSON.parse(utf8Decode(base64Decode(b64)))).toEqual({
      v: 1,
      nonce: "pimnonce0000",
      writtenAt: 1_790_000_000_000,
      action: "prompt.respond",
      args: { id: "p1", value: "Allow" },
      expect: { rev: 3 },
    });
    expect(scripts[0]).toContain("'/h/.pi/agent/forge/remote/42/inbox'");
  });

  it("keeps polling until the result arrives", async () => {
    const { client, scripts } = fakeClient((script, call) => {
      const tag = tagOf(script);
      if (call === 0) return `${tag} SENT\n${tag} PENDING\n`;
      if (call < 3) return `${tag} PENDING\n`;
      return `${tag} RESULT\n${result("pimnonce0000", "ok")}\n${tag} END\n`;
    });
    await expect(client.send(ROW, "ask.dismiss", { id: "q" })).resolves.toMatchObject({ ok: true });
    expect(scripts).toHaveLength(4);
  });

  it.each([
    ["stale", "pi.remote.errors.stale"],
    ["expired", "pi.remote.errors.expired"],
    ["invalid", "pi.remote.errors.invalid"],
    ["refused", "pi.remote.errors.refused"],
    ["unknown-action", "pi.remote.errors.unknown-action"],
    ["error", "pi.remote.errors.error"],
  ] as const)("maps result code %s to a typed error", async (code, key) => {
    const { client } = fakeClient((script) => {
      const tag = tagOf(script);
      return `${tag} SENT\n${tag} RESULT\n${result("pimnonce0000", code, "why")}\n${tag} END\n`;
    });
    const error = await client.send(ROW, "command.run", { line: "/x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).code).toBe(code);
    expect((error as RemoteError).detail).toBe("why");
    expect((error as RemoteError).i18nKey).toBe(key);
  });

  it("has friendly messages, including the update-forge line", () => {
    const r = (code: ResultCode): RemoteResult => ({
      v: 1,
      nonce: "n",
      ok: false,
      code,
      message: null,
      data: null,
      at: 0,
    });
    expect(errorFromResult(r("stale")).friendly).toBe("Already answered");
    expect(errorFromResult(r("unknown-action")).friendly).toBe(
      "Update forge on your computer to use this",
    );
    expect(Object.keys(REMOTE_ERROR_KEYS)).toHaveLength(9);
  });

  it("says no-channel without an inbox, transport when the exec fails", async () => {
    const none = fakeClient((script) => `${tagOf(script)} NOINBOX\n`);
    await expect(none.client.send(ROW, "ask.dismiss", { id: "q" })).rejects.toMatchObject({
      code: "no-channel",
    });
    const broken = createRemoteClient({
      run: async () => {
        throw new Error("Connection closed");
      },
      agentDir: async () => "/a",
    });
    await expect(broken.send(ROW, "ask.dismiss", { id: "q" })).rejects.toMatchObject({
      code: "transport",
    });
  });

  it("gives up after the wait: withdraws an unread action, else times out", async () => {
    const withdrawn = fakeClient(
      (script, call) => {
        const tag = tagOf(script);
        if (call === 0) return `${tag} SENT\n${tag} PENDING\n`;
        if (script.includes("WITHDRAWN")) return `${tag} WITHDRAWN\n`;
        return `${tag} PENDING\n`;
      },
      { waitMs: 0 },
    );
    await expect(withdrawn.client.send(ROW, "ask.dismiss", { id: "q" })).rejects.toMatchObject({
      code: "no-channel",
    });
    const taken = fakeClient(
      (script, call) => {
        const tag = tagOf(script);
        if (call === 0) return `${tag} SENT\n${tag} PENDING\n`;
        if (script.includes("WITHDRAWN")) return `${tag} TAKEN\n`;
        return `${tag} PENDING\n`;
      },
      { waitMs: 0 },
    );
    await expect(taken.client.send(ROW, "ask.dismiss", { id: "q" })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("reads state.json for the row's pid only", async () => {
    const { client } = fakeClient((script) => {
      const tag = /printf '%s STATE\\n' ([A-Za-z0-9_-]+);/.exec(script)?.[1] ?? "";
      return `${tag} STATE\n{"v":1,"pid":42,"rev":2,"prompt":null}\n${tag} END\n`;
    });
    expect(await client.readState(ROW)).toMatchObject({ pid: 42, rev: 2, prompt: null });
    expect(await client.readState({ ...ROW, pid: 41 })).toBeUndefined();
  });

  it("corrects writtenAt by the host clock offset", () => {
    expect(hostSkewMs(1_790_000_100, 1_790_000_000_000)).toBe(100_000);
    expect(hostSkewMs(1_790_000_000, 1_790_000_000_900)).toBe(0);
    expect(hostSkewMs(0, 5)).toBe(0);
  });
});
