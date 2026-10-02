// Polite screen-reader announcements: a message is spoken once when it appears or changes, only
// while `enabled` (the screen is focused), so a screen under the stack never speaks over the one
// on top.

import { useEffect, useRef } from "react";
import { AccessibilityInfo } from "react-native";

export function announce(message: string) {
  if (message) AccessibilityInfo.announceForAccessibility(message);
}

/** Speaks `message` once each time it changes to a new non-empty value. */
export function useAnnounceOnChange(message: string | null, enabled: boolean) {
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (!message) {
      last.current = null;
      return;
    }
    if (message === last.current) return;
    last.current = message;
    announce(message);
  }, [enabled, message]);
}
