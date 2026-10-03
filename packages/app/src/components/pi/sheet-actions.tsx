// The one action-bar form, for sheets and full screens alike: every button `flex: 1` at the md
// control height, so a loading spinner never changes the bar's height. Two actions: the secondary
// (ghost) first, the primary last. One action: never a full-width slab; it sits at the trailing
// edge at its natural width (a dismissal is a ghost text button, a primary keeps its accent). Red
// only on the button that destroys something (variant "destructive"), never on the bar.

import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function SheetActions({ children }: { children: ReactNode }) {
  // toArray drops null, undefined and false: only the actions actually shown.
  const present = Children.toArray(children);
  const only = present.length === 1 ? present[0] : null;
  if (only && isValidElement(only)) {
    const element = only as ReactElement<{ style?: unknown }>;
    return (
      <View style={styles.single}>
        {cloneElement(element, { style: [element.props.style, styles.natural] })}
      </View>
    );
  }
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
  single: { flex: 1, flexDirection: "row", justifyContent: "flex-end" },
  natural: { flex: 0, flexGrow: 0, flexShrink: 0, paddingHorizontal: theme.spacing[4] },
  bar: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
}));
