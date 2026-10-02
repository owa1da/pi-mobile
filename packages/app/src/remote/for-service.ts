// One remote client per host service, sharing its SSH connection and probed agent dir. The
// `writtenAt` clock is the phone's corrected by the host's clock offset (from the listing's
// hostNow), so a skewed phone clock never makes forge read a fresh action as expired.

import type { PiHostService } from "@/host/service";
import { connectionRunner, createRemoteClient, type RemoteClient } from "./client";

interface Bound {
  client: RemoteClient;
  skewMs: number;
}

const bound = new WeakMap<PiHostService, Bound>();

export function remoteFor(service: PiHostService): RemoteClient {
  const existing = bound.get(service);
  if (existing) return existing.client;
  const entry: Bound = { client: undefined as unknown as RemoteClient, skewMs: 0 };
  entry.client = createRemoteClient({
    run: connectionRunner(service.connection),
    agentDir: async () => (await service.environment()).agentDir,
    now: () => Date.now() + entry.skewMs,
  });
  bound.set(service, entry);
  return entry.client;
}

/**
 * Host clock minus phone clock, from a listing: `hostNowSec` (host, whole seconds) sampled when
 * the phone received it at `fetchedAtMs`. Offsets under 2 s are ignored (whole-second sampling).
 */
export function hostSkewMs(hostNowSec: number, fetchedAtMs: number): number {
  if (!Number.isFinite(hostNowSec) || hostNowSec <= 0 || !Number.isFinite(fetchedAtMs)) return 0;
  const skew = hostNowSec * 1000 - fetchedAtMs;
  return Math.abs(skew) < 2000 ? 0 : Math.round(skew);
}

export function setHostSkew(service: PiHostService, skewMs: number): void {
  remoteFor(service);
  const entry = bound.get(service);
  if (entry) entry.skewMs = skewMs;
}
