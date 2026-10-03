export interface CompactSheetSafeAreaPaddingInput {
  isCompact: boolean;
  isKeyboardVisible: boolean;
  hasFooter: boolean;
  safeAreaBottom: number;
}

export interface CompactSheetSafeAreaPadding {
  contentPaddingBottom?: number;
  footerPaddingBottom?: number;
}

interface BottomSheetVisibleContentHeightInput {
  containerHeight: number;
  contentPosition: number;
  handleHeight: number;
  keyboardHeight: number;
  isKeyboardVisible: boolean;
}

export function getBottomSheetVisibleContentHeight({
  containerHeight,
  contentPosition,
  handleHeight,
  keyboardHeight,
  isKeyboardVisible,
}: BottomSheetVisibleContentHeightInput): number {
  "worklet";
  return Math.max(
    0,
    containerHeight - contentPosition - handleHeight - (isKeyboardVisible ? keyboardHeight : 0),
  );
}

export function getCompactSheetSafeAreaPadding({
  isCompact,
  isKeyboardVisible,
  hasFooter,
  safeAreaBottom,
}: CompactSheetSafeAreaPaddingInput): CompactSheetSafeAreaPadding {
  if (!isCompact || isKeyboardVisible || safeAreaBottom <= 0) {
    return {};
  }

  if (hasFooter) {
    return { footerPaddingBottom: safeAreaBottom };
  }

  return { contentPaddingBottom: safeAreaBottom };
}

/** Gorhom's default handle: 10dp padding around a 4dp indicator, top and bottom. */
export const SHEET_HANDLE_HEIGHT = 24;
/** The tallest a phone sheet gets, as a fraction of the screen. */
export const SHEET_MAX_FRACTION = 0.9;

export interface FitSnapInput {
  /** Measured header, body content and footer heights (dp); 0 while not yet measured. */
  header: number;
  body: number;
  footer: number;
  windowHeight: number;
  /** A sheet with a text field: rises to its 90% point while the keyboard is up. */
  expandWithKeyboard: boolean;
}

/**
 * Snap points of a content-fitted sheet: it rests at its content's height (never above 90%), and a
 * sheet with a text field also gets the 90% point, which it takes only while the keyboard is up
 * (keyboardBehavior "extend"), so a field keeps its room above the keyboard and never collapses.
 * Before the first measure: a guess, replaced as soon as the content has laid out.
 */
export function fitSnapPoints({
  header,
  body,
  footer,
  windowHeight,
  expandWithKeyboard,
}: FitSnapInput): (number | string)[] {
  const top = `${Math.round(SHEET_MAX_FRACTION * 100)}%`;
  if (header <= 0 || body <= 0) return expandWithKeyboard ? ["50%", top] : ["50%"];
  const max = Math.floor(windowHeight * SHEET_MAX_FRACTION);
  const fit = Math.ceil(header + body + footer + SHEET_HANDLE_HEIGHT);
  if (fit >= max) return [top];
  return expandWithKeyboard ? [fit, top] : [fit];
}
