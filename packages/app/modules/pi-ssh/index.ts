import { requireNativeModule } from "expo";
import type { PiSshNativeModule } from "./src/PiSsh.types";

export type * from "./src/PiSsh.types";

/** Throws on platforms without the native module (web, iOS until implemented). */
export function requirePiSsh(): PiSshNativeModule {
  return requireNativeModule<PiSshNativeModule & object>("PiSsh") as unknown as PiSshNativeModule;
}
