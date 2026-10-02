// The open session's remote channel: polls its state.json (~1 s, faster for a few seconds after
// an action) while the chat is visible, only when the procs record says `"remote": 1`, and sends
// actions with writtenAt corrected by the host's clock offset.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionRow } from "@/host/types";
import { hasRemote, hostSkewMs, remoteFor, setHostSkew } from "@/remote";
import type { ArgsOf, RemoteAction, RemoteExpect, RemoteResult, RemoteState } from "@/remote/types";
import { RemoteError } from "@/remote/errors";
import { connectionStore } from "@/stores/app";
import type { SessionsEntry } from "@/stores/sessions-store";
import { usePoller } from "@/stores/use-polling";

const IDLE_MS = 1000;
const BOOST_MS = 300;
const BOOST_FOR_MS = 5000;
const ERROR_MS = 3000;

export interface RemoteChannel {
  /** True when the session publishes the channel (record `remote: 1`, live). */
  available: boolean;
  /** The latest state; undefined until read (or when the process has none). */
  state: RemoteState | undefined;
  /** True once a read finished for the current process (state may still be undefined). */
  loaded: boolean;
  send<A extends RemoteAction>(
    action: A,
    args: ArgsOf<A>,
    expect?: RemoteExpect,
  ): Promise<RemoteResult>;
  /** Read again now and keep polling fast for a few seconds. */
  boost(): void;
}

const sameState = (a: RemoteState | undefined, b: RemoteState | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.pid === b.pid &&
    a.rev === b.rev &&
    a.updatedAt === b.updatedAt);

export function useRemoteChannel(
  hostId: string,
  row: SessionRow,
  entry: SessionsEntry | undefined,
  active: boolean,
): RemoteChannel {
  const available = hasRemote(row);
  const pid = available ? row.pid : undefined;
  const [state, setState] = useState<RemoteState | undefined>(undefined);
  const [loadedPid, setLoadedPid] = useState<number | undefined>(undefined);
  const rowRef = useRef(row);
  rowRef.current = row;
  const pidRef = useRef(pid);
  pidRef.current = pid;
  const boostUntil = useRef(0);

  // A new process (pi restarted, /new in another pid): forget the old state at once.
  useEffect(() => {
    setState(undefined);
    setLoadedPid(undefined);
  }, [pid]);

  const hostNow = entry?.snapshot?.hostNow;
  const fetchedAt = entry?.fetchedAt;
  useEffect(() => {
    const service = connectionStore.getState().getService(hostId);
    if (service && hostNow !== undefined && fetchedAt !== undefined)
      setHostSkew(service, hostSkewMs(hostNow, fetchedAt));
  }, [fetchedAt, hostId, hostNow]);

  const run = useCallback(async () => {
    const service = connectionStore.getState().getService(hostId);
    const current = rowRef.current;
    if (!service || !hasRemote(current)) return ERROR_MS;
    const forPid = current.pid;
    try {
      const next = await remoteFor(service).readState(current);
      // A read that raced a process change is dropped.
      if (pidRef.current !== forPid) return 0;
      setState((prev) => (sameState(prev, next) ? prev : next));
      setLoadedPid(forPid);
    } catch {
      // Transport trouble is reported by the chat and listing polls; keep the last state.
      return ERROR_MS;
    }
    return Date.now() < boostUntil.current ? BOOST_MS : IDLE_MS;
  }, [hostId]);

  const kick = usePoller(run, IDLE_MS, active && available);

  const boost = useCallback(() => {
    boostUntil.current = Date.now() + BOOST_FOR_MS;
    kick();
  }, [kick]);

  const send = useCallback(
    async <A extends RemoteAction>(action: A, args: ArgsOf<A>, expect?: RemoteExpect) => {
      const service = connectionStore.getState().getService(hostId);
      if (!service) throw new RemoteError("transport", "Not connected");
      try {
        return await remoteFor(service).send(rowRef.current, action, args, expect);
      } finally {
        boost();
      }
    },
    [boost, hostId],
  );

  return {
    available,
    state: available ? state : undefined,
    loaded: available && loadedPid === pid,
    send,
    boost,
  };
}
