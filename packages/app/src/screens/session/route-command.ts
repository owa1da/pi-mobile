// An explicit command keeps its native route even when the selected session has ended.
import type { HostService, SessionRow } from "@/host/types";
import { commandName, nativeTarget, type NativeTool } from "@/remote/menu";
import type { RemoteCommand } from "@/remote/types";
import type { RemoteClient } from "@/remote/client";
import { sideRouteParams } from "@/screens/forge/side-route";

export async function routeSessionCommand(
  service: HostService,
  row: SessionRow,
  line: string,
  openNative: (tool: NativeTool, arg: string, extra?: Record<string, string>) => Promise<void>,
  sendRemote: RemoteClient["send"],
): Promise<void> {
  const target = nativeTarget(line);
  if (!target) {
    await service.runCommand(row, line);
    return;
  }
  if (target.tool === "side") {
    // Explicit /side is desktop's replacement command, never a visibility switch. Do this
    // before navigation: merely opening/polling SideView must not retire a conversation.
    const session = await service.ensureRemoteSession(row);
    const result = await sendRemote(
      session.row,
      "side.open",
      target.arg ? { text: target.arg } : {},
      {
        rev: session.state.rev,
        sessionId: row.sessionId,
      },
    );
    await openNative("side", "", sideRouteParams(result.data));
    return;
  }
  // Bare /btw can display saved answers without a running pi. Asking a new question is explicit
  // user text and needs the channel; merely reading those answers must not reopen the session.
  if (row.live || target.tool !== "btw" || target.arg) {
    // Native targets are app routes, not command.run. Forge's current terminal view may
    // publish a different menu (notably side omits /side); still require identity/readiness.
    await service.ensureRemoteSession(row);
  }
  await openNative(target.tool, target.arg);
}

/**
 * Whether a typed line goes the command route. Native screens always do; paths (`/tmp/a.ts …`)
 * and skills are messages; with a known list, an unlisted name is a message (pi treats it as text).
 * With no list yet the command route validates against fresh state and falls back to a message.
 */
export function slashIsCommand(
  line: string,
  commands: readonly RemoteCommand[] | undefined,
): boolean {
  const name = commandName(line);
  if (!name || name.startsWith("skill:") || name.includes("/")) return false;
  if (nativeTarget(line)) return true;
  return commands ? commands.some((command) => command.name === name) : true;
}
