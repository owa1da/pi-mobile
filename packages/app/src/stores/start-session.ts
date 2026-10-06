// startSession returns a pid/pane, not a session id: poll the listing until the new pi registers.

import type { SessionRow, SessionsSnapshot, StartSessionInput, StartedSession } from "@/host/types";
import { commandName } from "@/remote/menu";

// Deliberately volatile: no route param or disk draft can replay a dashboard action on reload.
const dashboardCommands = new Map<string, string>();
const commandKey = (hostId: string, sessionId: string) => JSON.stringify([hostId, sessionId]);

export function takeDashboardCommand(hostId: string, sessionId: string): string | undefined {
  const key = commandKey(hostId, sessionId);
  const command = dashboardCommands.get(key);
  dashboardCommands.delete(key);
  return command;
}

export async function startDashboardSession(
  service: StartingService,
  hostId: string,
  prompt: string,
): Promise<Located> {
  const name = commandName(prompt);
  const command = Boolean(name && !name.includes("/"));
  const found = await startAndLocate(service, { prompt: command ? "" : prompt });
  if (command && found.row) dashboardCommands.set(commandKey(hostId, found.row.sessionId), prompt);
  return found;
}

export interface StartingService {
  startSession(input: StartSessionInput): Promise<StartedSession>;
  listSessions(): Promise<SessionsSnapshot>;
}

export interface LocateOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface Located {
  started: StartedSession;
  row: SessionRow | null;
  snapshot: SessionsSnapshot | null;
}

export function matchesStarted(row: SessionRow, started: StartedSession): boolean {
  if (!row.live) return false;
  return row.pid === started.pid || row.tmux?.pane === started.pane;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function locateStarted(
  service: Pick<StartingService, "listSessions">,
  started: StartedSession,
  options: LocateOptions = {},
): Promise<Located> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let snapshot: SessionsSnapshot | null = null;
  for (;;) {
    try {
      snapshot = await service.listSessions();
      const row = snapshot.rows.find((candidate) => matchesStarted(candidate, started));
      if (row) return { started, row, snapshot };
    } catch {
      // a listing can fail while the new window starts; keep trying until the deadline
    }
    if (now() >= deadline) return { started, row: null, snapshot };
    await sleep(intervalMs);
  }
}

export async function startAndLocate(
  service: StartingService,
  input: StartSessionInput,
  options?: LocateOptions,
): Promise<Located> {
  const started = await service.startSession(input);
  return locateStarted(service, started, options);
}
