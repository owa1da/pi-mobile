// The one action-bar form, for sheets and full screens alike: every button `flex: 1` at the md
// control height, so a loading spinner never changes the bar's height. Two actions: the secondary
// (ghost) first, the primary last. One action: it takes the full width. Red only on the button
// that destroys something (variant "destructive"), never on the bar.

import { Children, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function SheetActions({ children }: { children: ReactNode }) {
  return (
    <View style={styles.row}>
      {Children.map(children, (child) =>
        child == null || child === false ? null : <View style={styles.cell}>{child}</View>,
      )}
    </View>
  );
}

/**
 * A full screen's action bar: SheetActions in the bottom slot, over a hairline, the same in every
 * state of the screen (data, empty, error) so its buttons never move.
 */
export function ActionBar({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View style={styles.bar} testID={testID}>
      <SheetActions>{children}</SheetActions>
    </View>
  );
}

/** Style for a Button inside SheetActions: fills its cell. */
export const sheetActionStyles = StyleSheet.create(() => ({
  button: { flex: 1 },
}));

const styles = StyleSheet.create((theme) => ({
  row: { flex: 1, flexDirection: "row", gap: theme.spacing[3] },
  cell: { flex: 1, flexDirection: "row" },
  bar: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
}));
