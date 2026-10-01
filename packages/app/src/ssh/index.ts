// App entry point for SSH. Only the native client is reachable from here; node-client.ts is a
// Node-only test double and must never be imported by app code.

import type { SshClient } from "./types";

export type * from "./types";
export { SSH_ERROR_CODES, SshError, isSshError, toSshError } from "./errors";
export type { SshErrorCode } from "./errors";

let client: SshClient | null = null;

/** The process-wide SSH client backed by the PiSsh native module (Android). */
export function getSshClient(): SshClient {
  if (client) return client;
  // Lazy so that importing "@/ssh" (e.g. for types/errors) never loads the native binding.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { requirePiSsh } =
    require("../../modules/pi-ssh/index") as typeof import("../../modules/pi-ssh/index");
  const { createNativeSshClient } = require("./native-client") as typeof import("./native-client");
  /* eslint-enable @typescript-eslint/no-require-imports */
  client = createNativeSshClient(requirePiSsh());
  return client;
}
