// Discovery only: the last live command list for each saved host, across sessions/reconnects.
// Never retain a PID, gates or other session state, and never authorize an action from this cache.
import type { RemoteCommand } from "@/remote/types";

const commands = new Map<string, readonly RemoteCommand[]>();
const listeners = new Set<() => void>();
export function cachedCommands(hostId: string): readonly RemoteCommand[] | undefined {
  return commands.get(hostId);
}
export function rememberCommands(hostId: string, next: readonly RemoteCommand[] | undefined): void {
  if (next === undefined) return;
  const previous = commands.get(hostId);
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  commands.set(
    hostId,
    next.map((command) => ({ ...command })),
  );
  for (const listener of listeners) listener();
}
export function forgetCommands(hostId: string): void {
  if (commands.delete(hostId)) for (const listener of listeners) listener();
}
export function subscribeCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
