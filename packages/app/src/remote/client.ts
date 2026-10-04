// The remote channel client: reads a pi process's state.json and sends it actions through its
// inbox, over the host's SSH connection (one exec per step). Only for sessions whose procs record
// says `"remote": 1`; the agent dir comes from the host probe.

import { wrapForAnyShell } from "@/host/commands";
import { base64EncodeText, utf8ByteLength } from "@/host/encoding";
import type { SessionRow } from "@/host/types";
import { RemoteError, errorFromResult } from "./errors";
import { parseRemoteResult, parseRemoteState } from "./parse";
import {
  framed,
  pollScript,
  readStateScript,
  sendScript,
  statuses,
  withdrawScript,
} from "./scripts";
import {
  REMOTE_PROTOCOL,
  type ArgsOf,
  type InboxAction,
  type RemoteAction,
  type RemoteExpect,
  type RemoteResult,
  type RemoteState,
} from "./types";

/** How long the app waits for forge's result before giving up (the contract's 30 s). */
export const RESULT_WAIT_MS = 30_000;
/** Forge's inbox limit includes JSON escaping and the envelope, not just text. */
export const MAX_INBOX_BYTES = 64 * 1024;

/** The row fields the channel needs: the process and whether its forge speaks the protocol. */
export type RemoteRow = Pick<SessionRow, "pid" | "live" | "remote"> &
  Partial<Pick<SessionRow, "sessionId">>;

export interface RemoteClientDeps {
  /** Runs a POSIX sh script on the host; resolves its stdout (rejects on a transport failure). */
  run(script: string, timeoutMs: number): Promise<string>;
  /** The host's agent dir (from the probe). */
  agentDir(): Promise<string>;
  /** Host clock (ms) for `writtenAt`: the phone's clock corrected for skew when known. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  nonce?: () => string;
  /** Total wait for a result (default RESULT_WAIT_MS). */
  waitMs?: number;
}

export interface RemoteClient {
  /** The process's published state; undefined when it has none (not remote, gone, unreadable). */
  readState(row: RemoteRow): Promise<RemoteState | undefined>;
  /** Sends one action and resolves its ok result; throws RemoteError otherwise. */
  send<A extends RemoteAction>(
    row: RemoteRow,
    action: A,
    args: ArgsOf<A>,
    expect?: RemoteExpect,
  ): Promise<RemoteResult>;
}

/** True when the row's process publishes the remote channel this app speaks. */
export function hasRemote(row: RemoteRow | undefined): boolean {
  return Boolean(row?.live && row.pid && row.remote === REMOTE_PROTOCOL);
}

export function makeRemoteNonce(): string {
  let out = "";
  for (let i = 0; i < 24; i++) out += Math.floor(Math.random() * 36).toString(36);
  return `pim${out}`;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The polling plan after the inbox write: [polls, interval s] per exec. The first exec already
 * polled ~1 s at 0.15 s steps; then 0.3 s steps for a few seconds, then 1 s steps to the deadline.
 */
const FIRST = { polls: 8, interval: "0.15" };
const NEXT = [
  { polls: 10, interval: "0.3" },
  { polls: 10, interval: "0.5" },
];
const LATE = { polls: 5, interval: "1" };

function stepFor(attempt: number): { polls: number; interval: string } {
  return NEXT[attempt] ?? LATE;
}

function stepMs(step: { polls: number; interval: string }): number {
  return Math.ceil(step.polls * Number(step.interval) * 1000);
}

function bindSession(
  row: RemoteRow,
  action: RemoteAction,
  expect: RemoteExpect | undefined,
): RemoteExpect | undefined {
  const sessionId = expect?.sessionId ?? row.sessionId;
  if (action === "input.submit" && !sessionId?.trim())
    throw new RemoteError("invalid", "input.submit requires a target session identity");
  if (row.sessionId !== undefined && sessionId !== row.sessionId)
    throw new RemoteError("stale", "The target session changed; the prompt was not sent");
  return sessionId !== undefined ? { ...expect, sessionId } : expect;
}

export function createRemoteClient(deps: RemoteClientDeps): RemoteClient {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const nonceOf = deps.nonce ?? makeRemoteNonce;
  const waitMs = deps.waitMs ?? RESULT_WAIT_MS;

  async function run(script: string, timeoutMs: number): Promise<string> {
    try {
      return await deps.run(script, timeoutMs);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RemoteError("transport", detail);
    }
  }

  function pidOf(row: RemoteRow): number {
    if (!hasRemote(row) || !row.pid) throw new RemoteError("no-channel");
    return row.pid;
  }

  function resultFrom(stdout: string, tag: string, nonce: string): RemoteResult | undefined {
    const body = framed(stdout, tag, "RESULT");
    if (body === undefined) return undefined;
    const result = parseRemoteResult(body, nonce);
    if (!result) throw new RemoteError("error", "The result could not be read");
    return result;
  }

  function settle(result: RemoteResult): RemoteResult {
    if (result.ok) return result;
    throw errorFromResult(result);
  }

  return {
    async readState(row) {
      if (!hasRemote(row) || !row.pid) return undefined;
      const agentDir = await deps.agentDir();
      const tag = nonceOf();
      const out = await run(readStateScript(agentDir, row.pid, tag), 15_000);
      const body = framed(out, tag, "STATE");
      if (body === undefined) return undefined;
      const state = parseRemoteState(body, row.pid);
      if (row.sessionId !== undefined && state?.sessionId !== row.sessionId) return undefined;
      return state;
    },

    async send(row, action, args, expect) {
      const pid = pidOf(row);
      const boundExpect = bindSession(row, action, expect);
      const agentDir = await deps.agentDir();
      const nonce = nonceOf();
      const message: InboxAction = {
        v: REMOTE_PROTOCOL,
        nonce,
        writtenAt: Math.round(now()),
        action,
        args,
        ...(boundExpect ? { expect: boundExpect } : {}),
      };
      const payload = JSON.stringify(message);
      if (utf8ByteLength(payload) > MAX_INBOX_BYTES)
        throw new RemoteError(
          "invalid",
          `The remote request is over ${MAX_INBOX_BYTES} UTF-8 bytes including JSON escaping; shorten the prompt.`,
        );
      const started = Date.now();
      const tag = nonceOf();
      const out = await run(
        sendScript({
          agentDir,
          pid,
          nonce,
          payloadB64: base64EncodeText(payload),
          tag,
          polls: FIRST.polls,
          interval: FIRST.interval,
        }),
        15_000 + stepMs(FIRST),
      );
      const words = statuses(out, tag);
      if (words.includes("NOINBOX")) throw new RemoteError("no-channel");
      if (words.includes("WRITEFAIL") || !words.includes("SENT"))
        throw new RemoteError("transport", "The action could not be written on the host");
      const first = resultFrom(out, tag, nonce);
      if (first) return settle(first);

      for (let attempt = 0; Date.now() - started < waitMs; attempt++) {
        const step = stepFor(attempt);
        const pollTag = nonceOf();
        let polled: string;
        try {
          polled = await run(
            pollScript(agentDir, pid, nonce, pollTag, step.polls, step.interval),
            15_000 + stepMs(step),
          );
        } catch (error) {
          // A dropped poll is not the end: the result stays on the host until read.
          if (Date.now() - started >= waitMs) throw error;
          await sleep(500);
          continue;
        }
        const result = resultFrom(polled, pollTag, nonce);
        if (result) return settle(result);
        if (statuses(polled, pollTag).includes("GONE")) throw new RemoteError("no-channel");
      }
      // Give up: take the action back if forge never read it, so it cannot act late.
      try {
        const wTag = nonceOf();
        const w = await run(withdrawScript(agentDir, pid, nonce, wTag), 10_000);
        if (statuses(w, wTag).includes("WITHDRAWN"))
          throw new RemoteError("no-channel", "forge did not pick up the action");
      } catch (error) {
        if (error instanceof RemoteError && error.code === "no-channel") throw error;
      }
      throw new RemoteError("timeout");
    },
  };
}

export interface ExecConnection {
  exec(
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}

/** `run` over an SSH connection: the script wrapped for any login shell, non-zero exit = failure. */
export function connectionRunner(connection: ExecConnection) {
  return async (script: string, timeoutMs: number): Promise<string> => {
    const result = await connection.exec(wrapForAnyShell(script), { timeoutMs });
    if (result.exitCode !== 0)
      throw new Error(
        result.stderr.trim().split("\n")[0] || `exit ${String(result.exitCode ?? "none")}`,
      );
    return result.stdout;
  };
}
