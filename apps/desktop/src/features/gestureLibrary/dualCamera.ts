import type { CombineMode } from "./combinedDetector";

/**
 * How the two cameras' decisions are merged, remembered between sessions. Shared by the Gesture library (calibration and
 * the live preview) and the part that reports camera gestures to recipes, so both merge the same way.
 */
const KEY = "dualCameraMode";
let mode: CombineMode = (() => {
  try {
    return localStorage.getItem(KEY) === "both" ? "both" : "either";
  } catch {
    return "either";
  }
})();
const listeners = new Set<() => void>();

export const dualCameraMode = (): CombineMode => mode;
export function setDualCameraMode(next: CombineMode): void {
  mode = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // The choice still holds for this session.
  }
  listeners.forEach((listener) => listener());
}
export const subscribeDualCameraMode = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
