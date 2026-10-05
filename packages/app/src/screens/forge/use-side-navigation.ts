// Navigation owns visibility, not lifetime. Serialize visibility changes across retained routes
// and rapid Back/re-entry. Pin modern ownership once; polling must never steal a desktop side.
import { useFocusEffect, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { SessionRow } from "@/host/types";
import { isRemoteError } from "@/remote/errors";
import type { RemoteSide } from "@/remote/types";
import { remoteMessage } from "@/screens/session/use-answers";
import type { RemoteChannel } from "@/screens/session/use-remote-channel";
import { retainSideNavigation, sideRouteParams, visibilityIdentity } from "./side-route";
import { openForge } from "./parts";

/** A queued entry belongs to this mount and session, not a later screen. */
function useLifetime(state: NavigationState) {
  const lifetime = useMemo(
    () => ({
      state,
      active: true,
      pending: false,
      current: undefined as SideOwnership | undefined,
    }),
    [state],
  );
  useEffect(() => {
    lifetime.active = true;
    return () => {
      lifetime.active = false;
    };
  }, [lifetime]);
  return lifetime;
}

/** Ctrl+/ equivalent: visibility only, captured at tap, serialized with route cleanup. */
export function useSideSwitch(hostId: string, row: SessionRow, channel: RemoteChannel) {
  const state = stateFor(JSON.stringify([hostId, row.sessionId, row.pid]));
  const lifetime = useLifetime(state);
  const [busy, setBusy] = useState<NavigationState | null>(null);
  const switchSide = useCallback(() => {
    const side = channel.state?.side;
    if (lifetime.pending || !channel.available || !side?.id) return;
    const target = { id: side.id, gen: side.gen };
    lifetime.pending = true;
    setBusy(lifetime.state);
    report(state, null);
    queueVisibility(state, { target }, async () => {
      try {
        if (!lifetime.active) return;
        const { id, gen } = target;
        const result = await channel.send(
          "side.view",
          { open: true, id, gen },
          { sessionId: row.sessionId },
        );
        acknowledgeVisibility(state, { id, gen }, result.data);
        if (!lifetime.active) return;
        openForge(hostId, row.sessionId, "side", sideRouteParams(result.data));
      } catch (error) {
        if (isRemoteError(error, "stale")) {
          channel.boost();
          await channel.read().catch(() => undefined);
        } else report(state, error);
      }
      return undefined;
    }).finally(() => {
      lifetime.pending = false;
      if (lifetime.active) setBusy(null);
    });
  }, [channel, hostId, lifetime, row.sessionId, state]);
  return { switchSide, busy: busy === state };
}

interface SideOwnership {
  id: string;
  gen?: number;
}
/** Unpinned ownership starts at the first visible publication, never a hidden predecessor. */
function visibleOwnership(side: RemoteSide | null | undefined): SideOwnership | undefined {
  return side?.id && side.open === true ? { id: side.id, gen: side.gen } : undefined;
}
function legacySideMatches(side: RemoteSide | null | undefined, file: string | null | undefined) {
  return !side?.id && side?.sessionFile === file;
}
interface SessionIdentity {
  pid?: number;
  sessionId: string;
}
function sameSession(current: SessionIdentity | undefined, identity: SessionIdentity) {
  return Boolean(
    current && current.pid === identity.pid && current.sessionId === identity.sessionId,
  );
}
function mayView(state: NavigationState, owner: symbol, open: boolean) {
  return open ? state.owner === owner : state.owner === undefined;
}

interface VisibilityAction {
  target?: SideOwnership;
}
function queueVisibility(
  state: NavigationState,
  action: VisibilityAction,
  run: () => Promise<void>,
) {
  state.visibility.add(action);
  state.tail = state.tail.then(run).finally(() => state.visibility.delete(action));
  return state.tail;
}

/** Rebase only queued pins matching our own acknowledged transition's input id/gen.
 * Polling, desktop transitions, stale results and missing identities never advance these pins.
 * The running target is included so retained routes remember their own accepted generation.
 */
function acknowledgeVisibility(state: NavigationState, sent: SideOwnership, data: unknown) {
  const accepted = visibilityIdentity(data);
  if (!accepted || accepted.id !== sent.id || sent.gen === undefined) return;
  for (const { target } of state.visibility) {
    if (target?.id === sent.id && target.gen === sent.gen) target.gen = accepted.gen;
  }
}

interface NavigationState {
  tail: Promise<void>;
  visibility: Set<VisibilityAction>;
  owner?: symbol;
  legacyPid?: number;
  error: unknown;
  listeners: Set<() => void>;
}
const navigation = new Map<string, NavigationState>();
function stateFor(key: string): NavigationState {
  let state = navigation.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), visibility: new Set(), error: null, listeners: new Set() };
    navigation.set(key, state);
  }
  return state;
}
function report(state: NavigationState, error: unknown) {
  state.error = error;
  for (const listener of state.listeners) listener();
}

/** Shared with main's existing send-error line: a failed Back remains visible after unmount. */
export function useSideNavigationError(hostId: string, row: SessionRow) {
  const { t } = useTranslation();
  const state = stateFor(JSON.stringify([hostId, row.sessionId, row.pid]));
  const subscribe = useCallback(
    (listener: () => void) => {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    [state],
  );
  const snapshot = useCallback(() => state.error, [state]);
  const error = useSyncExternalStore(subscribe, snapshot, snapshot);
  const clearError = useCallback(() => report(state, null), [state]);
  return { error: error ? remoteMessage(t, error) : null, clearError };
}

export function useSideNavigation(
  hostId: string,
  row: SessionRow,
  channel: RemoteChannel,
  entry?: string,
  sideId?: string,
  sideGen?: string,
) {
  const errors = useSideNavigationError(hostId, row);
  const stack = useNavigation();
  useEffect(() => retainSideNavigation(stack), [stack]);
  const state = stateFor(JSON.stringify([hostId, row.sessionId, row.pid]));
  const lifetime = useLifetime(state);
  const latest = useRef({ channel, row });
  latest.current = { channel, row };
  const token = useRef(Symbol("side route"));
  const closed = useRef(false);
  const [focused, setFocused] = useState(false);
  const side = channel.state?.side;
  const sideFile = side?.sessionFile;
  const file = useRef(sideFile);
  if (sideFile) file.current = sideFile; // Older Forge's file-based behaviour.
  const owned = lifetime;
  const ownedEntry = useRef(entry);
  const shown = useRef(false);

  const view = useCallback(
    (open: boolean) => {
      const identity = { pid: row.pid, sessionId: row.sessionId };
      const owner = token.current;
      const action: VisibilityAction = {};
      // Unmount invalidates queued shows only. A hide stays valid after unmount (Back can blur,
      // then unmount mid-read); the owner check and Forge's atomic stale check still guard it.
      const valid = () => (!open || lifetime.active) && sameSession(latest.current.row, identity);
      return queueVisibility(state, action, async () => {
        if (!valid()) return;
        // A newer screen owns the side now. Its show wins over an older route's queued hide.
        if (!mayView(state, owner, open)) return;
        if (state.legacyPid === identity.pid) return;
        const targetFile = file.current;
        const current = latest.current;
        try {
          const fresh = await current.channel.read();
          if (!fresh || !sameSession(fresh, identity)) return;
          // Missing creation ack pins are simply unpinned. Capture the first visible state,
          // including this last read on leave; never infer a pending creation or hidden owner.
          owned.current ??= visibleOwnership(fresh.side);
          action.target ??= owned.current;
          if (!action.target && (!targetFile || !legacySideMatches(fresh.side, targetFile))) return;
          if (!valid() || !mayView(state, owner, open)) return;
          // Forge checks id/gen atomically; delayed publication must not suppress Back.
          const target = action.target && { ...action.target };
          const result = await current.channel.send(
            "side.view",
            target ? { open, ...target } : { open },
            target
              ? { sessionId: identity.sessionId }
              : { rev: fresh.rev, sessionId: identity.sessionId },
          );
          if (target) acknowledgeVisibility(state, target, result.data);
        } catch (error) {
          // Older Forge keeps its previous visibility behaviour. Never close/recreate as fallback.
          if (isRemoteError(error, "unknown-action")) state.legacyPid = identity.pid;
          // Desktop changed the side or visibility. Expected: no retry, no error, no fallback.
          else if (!isRemoteError(error, "stale")) report(state, error);
        }
        return undefined;
      });
    },
    [lifetime, owned, row.pid, row.sessionId, state],
  );

  useFocusEffect(
    useCallback(() => {
      state.owner = token.current;
      closed.current = false;
      shown.current = Boolean(sideId);
      const entered = latest.current.channel.state?.side;
      if (ownedEntry.current !== entry || !owned.current) {
        if (sideId) owned.current = { id: sideId, gen: sideGen ? Number(sideGen) : undefined };
        // Without accepted action pins, bind only the first visible side. A hidden first poll
        // can be the replaced/forked side's predecessor while Forge publication is debounced.
        else owned.current = visibleOwnership(entered);
      }
      ownedEntry.current = entry;
      setFocused(true);
      return () => {
        setFocused(false);
        if (state.owner !== token.current) return;
        state.owner = undefined;
        if (!closed.current) void view(false);
      };
    }, [entry, owned, sideGen, sideId, state, view]),
  );
  useEffect(() => {
    if (!channel.loaded || closed.current) return;
    if (focused) owned.current ??= visibleOwnership(side);
    if (
      focused &&
      (owned.current || (sideFile && !side?.id)) &&
      (!shown.current || !owned.current)
    ) {
      shown.current = true;
      void view(true);
    }
  }, [channel.loaded, entry, focused, owned, side, sideFile, sideId, view]);
  const perform = useCallback(
    <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
      const identity = { pid: row.pid, sessionId: row.sessionId };
      // Queued screen actions (side.send can start a turn) never run after unmount/session change.
      const operation = state.tail.then(() =>
        lifetime.active && sameSession(latest.current.row, identity) ? run() : fallback,
      );
      state.tail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    [lifetime, row.pid, row.sessionId, state],
  );
  const created = useCallback(
    (data: unknown, opened?: RemoteSide | null) => {
      if (!opened) {
        // An accepted, explicit side.open is the only way to replace this screen's ownership.
        owned.current = visibilityIdentity(data);
        closed.current = false;
      } else if (!owned.current) owned.current = visibleOwnership(opened);
      if (opened?.sessionFile) file.current = opened.sessionFile;
      shown.current = true;
    },
    [owned],
  );
  const markClosed = useCallback(() => {
    closed.current = true;
  }, []);

  return {
    focused,
    ...errors,
    perform,
    created,
    closed: markClosed,
  };
}
