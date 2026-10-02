// Immersive system bars for the collapsed landscape terminal (Android). A no-op where the native
// module is absent (web, iOS, unit tests).
import { requireOptionalNativeModule } from "expo";

interface PiSystemBarsNativeModule {
  setImmersive(immersive: boolean): boolean;
}

const native = requireOptionalNativeModule<PiSystemBarsNativeModule>("PiSystemBars");

/** Hide (true) or restore (false) the status and navigation bars; swipe from an edge peeks them. */
export function setImmersive(immersive: boolean): void {
  native?.setImmersive(immersive);
}
