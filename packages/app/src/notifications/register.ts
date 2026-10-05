import { shQuote, wrapForAnyShell } from "@/host/commands";
import type { SshConnection } from "@/ssh/types";

export const LEASE_MS = 30 * 24 * 60 * 60 * 1000;
export const PUSH_EXEC_TIMEOUT_MS = 3000;
export interface RegistrationService {
  environment(): Promise<{ agentDir: string }>;
  connection: Pick<SshConnection, "exec">;
}

function filename(installationId: string, hostId: string): string {
  for (const id of [installationId, hostId]) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid push device identifier");
  }
  return `${installationId}.${hostId}.json`;
}

export function registrationScript(
  agentDir: string,
  installationId: string,
  hostId: string,
): string {
  const file = filename(installationId, hostId);
  return `set -eu
umask 077
dir=${shQuote(`${agentDir}/forge/push/devices`)}
mkdir -p -m 700 "$dir"
chmod 700 "$dir"
tmp=$(mktemp "$dir/.device.XXXXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM
cat > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$dir/${file}"
`;
}

export function unregisterScript(agentDir: string, installationId: string, hostId: string): string {
  return `set -eu\numask 077\nrm -f ${shQuote(`${agentDir}/forge/push/devices/${filename(installationId, hostId)}`)}\n`;
}

export async function registerDevice(
  service: RegistrationService,
  installationId: string,
  hostId: string,
  token: string,
  now = Date.now(),
): Promise<void> {
  const { agentDir } = await service.environment();
  const result = await service.connection.exec(
    wrapForAnyShell(registrationScript(agentDir, installationId, hostId)),
    {
      stdin: JSON.stringify({ v: 1, transport: "expo", token, hostId, expiresAt: now + LEASE_MS }),
      timeoutMs: PUSH_EXEC_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) throw new Error("Push registration failed");
}

export async function unregisterDevice(
  service: RegistrationService,
  installationId: string,
  hostId: string,
): Promise<void> {
  const { agentDir } = await service.environment();
  const result = await service.connection.exec(
    wrapForAnyShell(unregisterScript(agentDir, installationId, hostId)),
    { timeoutMs: PUSH_EXEC_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) throw new Error("Push removal failed");
}
