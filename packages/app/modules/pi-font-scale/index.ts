// Reload after a runtime system font-scale change (Android). A no-op where the native module is
// absent (web, iOS, unit tests).
import { requireOptionalNativeModule } from "expo";

interface PiFontScaleNativeModule {
  reloadForFontScale(): boolean;
}

const native = requireOptionalNativeModule<PiFontScaleNativeModule>("PiFontScale");

/** Reload the React host so text is re-measured at a new system font scale. */
export function reloadForFontScale(): boolean {
  return native?.reloadForFontScale() ?? false;
}
