// The touch-target floor, one number for the whole app: 48dp on Android (Material), 44pt on iOS
// (HIG). Every control's hit area (its bounds, or bounds plus hitSlop) is at least this size.

import { Platform } from "react-native";

export const MIN_TOUCH: number = Platform.select({ android: 48, default: 44 });

/** hitSlop on each side that lifts a `visual`-dp control to the touch floor. */
export function touchSlop(visual: number): number {
  return Math.max(0, Math.ceil((MIN_TOUCH - visual) / 2));
}
