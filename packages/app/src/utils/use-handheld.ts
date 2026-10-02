// A phone, in either orientation. Unistyles breakpoints follow the window width, so a phone
// turned to landscape (~900dp wide) reads as "md" and would get desktop-sized headers and
// dialog sheets. Touch targets and header rhythm must stay phone-sized there.

import { Platform, useWindowDimensions } from "react-native";

/** Shorter side below this (dp) is a phone; tablets start at 600dp (Material window classes). */
export const HANDHELD_MAX_SHORT_SIDE = 600;

export function isHandheldSize(width: number, height: number, os: string = Platform.OS): boolean {
  if (os === "web") return false;
  return Math.min(width, height) < HANDHELD_MAX_SHORT_SIDE;
}

export function useIsHandheld(): boolean {
  const { width, height } = useWindowDimensions();
  return isHandheldSize(width, height);
}
