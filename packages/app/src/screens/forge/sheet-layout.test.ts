import { describe, expect, it } from "vitest";
import { getBottomSheetVisibleContentHeight } from "@/components/adaptive-modal-sheet-layout";
import { FIELD_SHEETS, sheetSnapPoints, topSnapFraction } from "./sheet-layout";

// The emulator the journey runs on (1080x2400 at 420 dpi): 914 dp tall, Gboard about 362 dp.
const SCREEN = 914;
const KEYBOARD = 362;
const HANDLE = 24;
/** The sheet's header (title row) and footer (two buttons) around the body. */
const CHROME = 60 + 72;
/** One labelled field: what must stay visible for it to keep focus. */
const FIELD = 80;

function bodyWithKeyboard(points: readonly string[]): number {
  const position = SCREEN * (1 - topSnapFraction(points));
  const visible = getBottomSheetVisibleContentHeight({
    containerHeight: SCREEN,
    contentPosition: position,
    handleHeight: HANDLE,
    keyboardHeight: KEYBOARD,
    isKeyboardVisible: true,
  });
  return visible - CHROME;
}

describe("forge sheet snap points", () => {
  it("leaves no room for a field above the keyboard at one 55% point (the /pause bug)", () => {
    expect(bodyWithKeyboard(["55%"])).toBeLessThan(FIELD);
  });

  it("gives every sheet with a text field room for its fields above the keyboard", () => {
    for (const kind of FIELD_SHEETS) {
      expect(bodyWithKeyboard(sheetSnapPoints(kind))).toBeGreaterThanOrEqual(3 * FIELD);
      expect(sheetSnapPoints(kind)[0]).toBe("55%");
    }
  });

  it("keeps the sheets without a field at one resting point", () => {
    for (const kind of ["clear", "sync", undefined]) expect(sheetSnapPoints(kind)).toEqual(["55%"]);
  });
});
