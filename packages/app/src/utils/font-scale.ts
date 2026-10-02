/** A runtime font-scale change needs a re-measure; the scale the app started with never does. */
export function fontScaleChanged(initial: number, current: number): boolean {
  return Math.abs(current - initial) > 0.001;
}
