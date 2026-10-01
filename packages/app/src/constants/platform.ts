import { Platform } from "react-native";

// ---------------------------------------------------------------------------
// Runtime environment constants
//
// These are the ONLY platform gates in the app.
//   isWeb    → DOM APIs (document, window, <div>, addEventListener)
//   isNative → Native-only APIs (Haptics, StatusBar, keyboard controller)
//   isDev    → Development-only diagnostics and instrumentation
//
// For layout decisions, use useIsCompactFormFactor() from constants/layout.ts.
// ---------------------------------------------------------------------------

/** Browser — the JS runtime has access to the DOM. */
export const isWeb = Platform.OS === "web";

/** iOS or Android — the JS runtime is React Native. */
export const isNative = Platform.OS !== "web";

/** Development build/runtime — true in Metro dev bundles, false in production. */
export const isDev = Boolean((globalThis as { __DEV__?: boolean }).__DEV__);

/** Pi has no desktop wrapper; kept so shared UI code can keep its desktop branches inert. */
export function getIsElectron(): boolean {
  return false;
}

/** Pi has no desktop wrapper; always false. */
export function getIsElectronMac(): boolean {
  return false;
}
