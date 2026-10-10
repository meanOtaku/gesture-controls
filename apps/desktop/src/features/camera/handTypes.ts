/** Hand landmarks as MediaPipe reports them: 21 points per hand, the same order everywhere (0 = wrist, 4 = thumb tip, 8 = index tip...). */
export const LANDMARK_COUNT = 21;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface TrackedHand {
  /**
   * MediaPipe's own label, as reported for the raw camera picture. Use `physicalHand`, which can swap it if a camera
   * turns out to report left and right the other way round.
   */
  modelHandedness: "Left" | "Right";
  /** How sure the model is of the handedness, 0 to 1. */
  score: number;
  /** Image coordinates: x and y from 0 to 1 across the picture, z a relative depth (smaller is nearer the camera). */
  image: Point3[];
  /** Metres, with the origin at the middle of the hand: independent of how far the hand is from the camera. */
  world: Point3[];
}

export interface HandFrame {
  /** Counts up from 0 within a camera session. */
  frameIndex: number;
  /** When the picture was taken, on the browser's monotonic clock (`performance.now()`), in milliseconds. */
  captureMs: number;
  hands: TrackedHand[];
}

const SWAP_KEY = "cameraHandsSwapped";
let swapped = (() => {
  try {
    return localStorage.getItem(SWAP_KEY) === "1";
  } catch {
    return false;
  }
})();
const swapListeners = new Set<() => void>();

/** Whether left and right are swapped for this camera. Off by default: the model's label is taken as the physical hand. */
export const handsSwapped = (): boolean => swapped;
export function setHandsSwapped(value: boolean): void {
  swapped = value;
  try {
    localStorage.setItem(SWAP_KEY, value ? "1" : "0");
  } catch {
    // The choice still holds for this session.
  }
  swapListeners.forEach((listener) => listener());
}
export const subscribeHandsSwapped = (listener: () => void): (() => void) => {
  swapListeners.add(listener);
  return () => swapListeners.delete(listener);
};

/** The physical hand (as seen from the person wearing the watch): the model's label, swapped if the person says their camera reports it the other way. */
export function physicalHand(hand: Pick<TrackedHand, "modelHandedness">): "Left" | "Right" {
  if (!swapped) return hand.modelHandedness;
  return hand.modelHandedness === "Left" ? "Right" : "Left";
}

/** The app's cameras: a primary, and an optional second one that is treated as a separate source. */
export type CameraSlot = "primary" | "secondary";

export interface HandDetector {
  /** Finds the hands in one picture. `timestampMs` must increase from one call to the next. */
  detect(source: TexImageSource, timestampMs: number): TrackedHand[];
  close(): void;
}
