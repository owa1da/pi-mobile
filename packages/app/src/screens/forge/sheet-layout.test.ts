import { describe, expect, it } from "vitest";
import {
  fitSnapPoints,
  getBottomSheetVisibleContentHeight,
  SHEET_HANDLE_HEIGHT,
} from "@/components/adaptive-modal-sheet-layout";
import { FIELD_SHEETS } from "./sheet-layout";

// The emulator the journey runs on (1080x2400 at 420 dpi): 914 dp tall, Gboard about 362 dp.
const SCREEN = 914;
const KEYBOARD = 362;
/** The sheet's header (title row) and footer (two buttons) around the body. */
const HEADER = 60;
const FOOTER = 72;
/** One labelled field: what must stay visible for it to keep focus. */
const FIELD = 80;

function positionOf(point: number | string): number {
  const height = typeof point === "number" ? point : (SCREEN * Number.parseFloat(point)) / 100;
  return SCREEN - height;
}

function bodyWithKeyboard(points: readonly (number | string)[]): number {
  const visible = getBottomSheetVisibleContentHeight({
    containerHeight: SCREEN,
    contentPosition: positionOf(points[points.length - 1]!),
    handleHeight: SHEET_HANDLE_HEIGHT,
    keyboardHeight: KEYBOARD,
    isKeyboardVisible: true,
  });
  return visible - HEADER - FOOTER;
}

const fit = (body: number, expandWithKeyboard: boolean) =>
  fitSnapPoints({ header: HEADER, body, footer: FOOTER, windowHeight: SCREEN, expandWithKeyboard });

describe("content-fitted sheets", () => {
  it("rest at their content's height, not at a fixed 90%", () => {
    // /rename: one field. /export done: two lines of text.
    expect(fit(110, false)).toEqual([HEADER + 110 + FOOTER + SHEET_HANDLE_HEIGHT]);
    const [rest] = fit(110, true);
    expect(typeof rest).toBe("number");
    expect(rest as number).toBeLessThan(SCREEN * 0.4);
  });

  it("never rest above 90%: a tall body scrolls inside the 90% sheet", () => {
    expect(fit(2000, false)).toEqual(["90%"]);
    expect(fit(2000, true)).toEqual(["90%"]);
  });

  it("give every sheet with a text field room above the keyboard (the /pause bug)", () => {
    for (const _kind of FIELD_SHEETS) {
      const points = fit(3 * FIELD, true);
      expect(points[points.length - 1]).toBe("90%");
      expect(bodyWithKeyboard(points)).toBeGreaterThanOrEqual(3 * FIELD);
    }
  });

  it("a resting point alone would leave no room for a field above the keyboard", () => {
    expect(bodyWithKeyboard(fit(3 * FIELD, false))).toBeLessThan(FIELD);
  });

  it("guesses until measured, keeping the keyboard point for field sheets", () => {
    expect(
      fitSnapPoints({
        header: 0,
        body: 0,
        footer: 0,
        windowHeight: SCREEN,
        expandWithKeyboard: true,
      }),
    ).toEqual(["50%", "90%"]);
    expect(
      fitSnapPoints({
        header: 0,
        body: 0,
        footer: 0,
        windowHeight: SCREEN,
        expandWithKeyboard: false,
      }),
    ).toEqual(["50%"]);
  });
});
