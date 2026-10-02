import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { base64EncodeText } from "@/host/encoding";
import {
  framed,
  pollScript,
  readStateScript,
  remoteDir,
  sendScript,
  statuses,
  withdrawScript,
} from "./scripts";

const TAG = "tagABCDEF12";
const NONCE = "pimnonce000001";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An agent dir whose path a careless script would break: spaces, quotes, $, backticks, ;. */
function hostileAgentDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pim-remote-"));
  dirs.push(root);
  const agent = path.join(root, `a 'b' "c" $HOME \`id\`; x`);
  fs.mkdirSync(path.join(agent, "forge", "remote", "42", "inbox"), { recursive: true });
  fs.mkdirSync(path.join(agent, "forge", "remote", "42", "results"), { recursive: true });
  return agent;
}

const sh = (script: string) => execFileSync("sh", ["-c", script], { encoding: "utf8" });

describe("remote scripts", () => {
  it("builds the remote dir and refuses bad pids and nonces", () => {
    expect(remoteDir("/home/u/.pi/agent/", 7)).toBe("/home/u/.pi/agent/forge/remote/7");
    expect(() => remoteDir("/a", 0)).toThrow();
    expect(() => remoteDir("/a", 1.5)).toThrow();
    expect(() => readStateScript("/a", 1, "bad tag")).toThrow();
    expect(() =>
      sendScript({
        agentDir: "/a",
        pid: 1,
        nonce: "../../etc",
        payloadB64: "",
        tag: TAG,
        polls: 0,
        interval: "0.1",
      }),
    ).toThrow();
    expect(() =>
      sendScript({
        agentDir: "/a",
        pid: 1,
        nonce: NONCE,
        payloadB64: "x'; rm -rf /",
        tag: TAG,
        polls: 0,
        interval: "0.1",
      }),
    ).toThrow();
  });

  it("writes the inbox file with tmp + mv under a hostile agent dir, payload intact", () => {
    const agent = hostileAgentDir();
    const payload = JSON.stringify({
      v: 1,
      nonce: NONCE,
      args: { value: 'it\'s $(id) `x` "q"\n✓' },
    });
    const script = sendScript({
      agentDir: agent,
      pid: 42,
      nonce: NONCE,
      payloadB64: base64EncodeText(payload),
      tag: TAG,
      polls: 0,
      interval: "0.05",
    });
    expect(script).toContain(`mv "$d/.$N.tmp" "$d/$N.json"`);
    const out = sh(script);
    expect(statuses(out, TAG)).toEqual(["SENT", "PENDING"]);
    const inbox = path.join(agent, "forge", "remote", "42", "inbox");
    expect(fs.readdirSync(inbox)).toEqual([`${NONCE}.json`]);
    expect(fs.readFileSync(path.join(inbox, `${NONCE}.json`), "utf8")).toBe(payload);
  });

  it("says NOINBOX when the process has no channel", () => {
    const agent = hostileAgentDir();
    const out = sh(
      sendScript({
        agentDir: agent,
        pid: 43,
        nonce: NONCE,
        payloadB64: base64EncodeText("{}"),
        tag: TAG,
        polls: 0,
        interval: "0.05",
      }),
    );
    expect(statuses(out, TAG)).toEqual(["NOINBOX"]);
  });

  it("reads a whole result once and removes it; waits on a partial one", () => {
    const agent = hostileAgentDir();
    const file = path.join(agent, "forge", "remote", "42", "results", `${NONCE}.json`);
    fs.writeFileSync(file, '{"v":1,"nonce":"x","ok":tr');
    let out = sh(pollScript(agent, 42, NONCE, TAG, 1, "0.05"));
    expect(statuses(out, TAG)).toEqual(["PENDING"]);
    expect(fs.existsSync(file)).toBe(true);
    const body = `{"v":1,"nonce":"${NONCE}","ok":true,"code":"ok","message":null,"data":null,"at":1}`;
    fs.writeFileSync(file, body);
    out = sh(pollScript(agent, 42, NONCE, TAG, 1, "0.05"));
    expect(framed(out, TAG, "RESULT")).toBe(body);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("polls GONE when the process's remote dir is gone", () => {
    const agent = hostileAgentDir();
    expect(statuses(sh(pollScript(agent, 99, NONCE, TAG, 1, "0.05")), TAG)).toEqual(["GONE"]);
  });

  it("frames state.json, or says NONE", () => {
    const agent = hostileAgentDir();
    expect(statuses(sh(readStateScript(agent, 42, TAG)), TAG)).toEqual(["NONE"]);
    fs.writeFileSync(path.join(agent, "forge", "remote", "42", "state.json"), '{"v":1,"pid":42}');
    expect(framed(sh(readStateScript(agent, 42, TAG)), TAG, "STATE")).toBe('{"v":1,"pid":42}');
  });

  it("withdraws an unread action, or says it was taken", () => {
    const agent = hostileAgentDir();
    const file = path.join(agent, "forge", "remote", "42", "inbox", `${NONCE}.json`);
    fs.writeFileSync(file, "{}");
    expect(statuses(sh(withdrawScript(agent, 42, NONCE, TAG)), TAG)).toEqual(["WITHDRAWN"]);
    expect(statuses(sh(withdrawScript(agent, 42, NONCE, TAG)), TAG)).toEqual(["TAKEN"]);
  });
});
