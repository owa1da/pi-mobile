import { useMemo, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { useIsHandheld } from "@/utils/use-handheld";

interface ScreenHeaderProps {
  left?: ReactNode;
  right?: ReactNode;
  leftStyle?: StyleProp<ViewStyle>;
  rightStyle?: StyleProp<ViewStyle>;
  borderless?: boolean;
  onRowLayout?: (event: LayoutChangeEvent) => void;
}

/**
 * Shared frame for the home/back headers so we only maintain padding, border,
 * and safe-area logic in one place.
 */
export function ScreenHeader({
  left,
  right,
  leftStyle,
  rightStyle,
  borderless,
  onRowLayout,
}: ScreenHeaderProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isHandheld = useIsHandheld();
  // A phone in landscape is "md" wide but still a phone: keep the mobile rhythm and targets.
  const isMobile = useIsCompactFormFactor() || isHandheld;
  // Only add extra padding on mobile for better touch targets; on desktop, only use safe area insets
  const topPadding = isMobile ? HEADER_TOP_PADDING_MOBILE : 0;
  // Mobile: a 4dp inset puts the glyph of every 44dp icon button (back, +, edit) on the 16dp row
  // gutter; a bare title adds its own 12dp lead (see hosts-screen) to land on the same line.
  const baseHorizontalPadding = isMobile ? theme.spacing[1] : theme.spacing[3];

  const innerStyle = useMemo(
    () => [styles.inner, { paddingTop: insets.top + topPadding }],
    [insets.top, topPadding],
  );
  const rowStyle = useMemo(
    () => [
      styles.row,
      { paddingLeft: baseHorizontalPadding, paddingRight: baseHorizontalPadding },
      isHandheld && styles.handheldRow,
      borderless && styles.borderless,
    ],
    [baseHorizontalPadding, borderless, isHandheld],
  );
  const leftCombinedStyle = useMemo(() => [styles.left, leftStyle], [leftStyle]);
  const rightCombinedStyle = useMemo(() => [styles.right, rightStyle], [rightStyle]);

  return (
    <View style={styles.header} testID="screen-header">
      <View style={innerStyle}>
        <View onLayout={onRowLayout} style={rowStyle}>
          <View style={leftCombinedStyle}>{left}</View>
          <View style={rightCombinedStyle}>{right}</View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    backgroundColor: theme.colors.surface0,
  },
  inner: {},
  row: {
    position: "relative",
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  left: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  handheldRow: {
    height: HEADER_INNER_HEIGHT_MOBILE,
  },
  borderless: {
    borderBottomColor: "transparent",
  },
}));
