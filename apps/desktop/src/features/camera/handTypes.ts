/** Hand landmarks as MediaPipe reports them: 21 points per hand, the same order everywhere (0 = wrist, 4 = thumb tip, 8 = index tip...). */
export const LANDMARK_COUNT = 21;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface TrackedHand {
  /**
   * MediaPipe's own label. It assumes a mirrored (selfie) picture, and a webcam's raw picture is not mirrored, so this is
   * the *opposite* of the physical hand for raw camera frames. Use `physicalHand`.
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

/** The physical hand (as seen from the person wearing the watch) for a hand found in a raw, unmirrored camera picture. */
export function physicalHand(hand: Pick<TrackedHand, "modelHandedness">): "Left" | "Right" {
  return hand.modelHandedness === "Left" ? "Right" : "Left";
}

export interface HandDetector {
  /** Finds the hands in one picture. `timestampMs` must increase from one call to the next. */
  detect(source: TexImageSource, timestampMs: number): TrackedHand[];
  close(): void;
}
