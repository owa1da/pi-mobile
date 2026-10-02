// Theme-reactive icons and spinner for the Pi screens (withUnistyles leaf wrappers; no useUnistyles).

import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  Pencil,
  Plus,
  ShieldAlert,
  Square,
} from "lucide-react-native";
import { ActivityIndicator, type ActivityIndicatorProps } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { PiIcon } from "@/components/icons/pi-icon";
import type { Theme } from "@/styles/theme";

export const ThemedArrowUp = withUnistyles(ArrowUp);
export const ThemedChevronDown = withUnistyles(ChevronDown);
export const ThemedChevronRight = withUnistyles(ChevronRight);
export const ThemedCopy = withUnistyles(Copy);
export const ThemedPencil = withUnistyles(Pencil);
export const ThemedPlus = withUnistyles(Plus);
export const ThemedShieldAlert = withUnistyles(ShieldAlert);
export const ThemedSquare = withUnistyles(Square);
export const ThemedPiIcon = withUnistyles(PiIcon);

export const foregroundColor = (theme: Theme) => ({ color: theme.colors.foreground });
export const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
export const accentForegroundColor = (theme: Theme) => ({ color: theme.colors.accentForeground });
export const surfaceColor = (theme: Theme) => ({ color: theme.colors.surface0 });
export const dangerColor = (theme: Theme) => ({ color: theme.colors.statusDanger });
export const extraMutedColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

const ThemedSpinner = withUnistyles(ActivityIndicator, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

/**
 * A spinner is never announced: TalkBack would read "in progress" on every mount. The state it
 * stands for is carried by a label nearby (busy state, a loading container, a status line).
 */
export function MutedSpinner(props: Omit<ActivityIndicatorProps, "color">) {
  return (
    <ThemedSpinner
      {...props}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    />
  );
}
