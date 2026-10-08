import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { LANDMARK_COUNT, type HandDetector, type Point3, type TrackedHand } from "./handTypes";

/** Where the runtime and the model are served from: the app's own files, never the network. */
export const MEDIAPIPE_WASM_BASE = "/mediapipe/wasm";
export const HAND_MODEL_URL = "/mediapipe/hand_landmarker.task";

export interface DetectorOptions {
  maxHands?: number;
  /** Tried first; the detector falls back to the CPU if the graphics one cannot start. */
  delegate?: "GPU" | "CPU";
}

const toPoints = (points: { x: number; y: number; z: number }[] | undefined): Point3[] =>
  (points ?? []).slice(0, LANDMARK_COUNT).map(({ x, y, z }) => ({ x, y, z }));

/** Loads MediaPipe's hand landmarker. Throws with a plain reason if the runtime or the model cannot be loaded. */
export async function createMediapipeDetector(options: DetectorOptions = {}): Promise<HandDetector> {
  // Loaded only when the camera is first turned on, so the app's own start-up does not carry it.
  const { FilesetResolver, HandLandmarker: Landmarker } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
  const make = (delegate: "GPU" | "CPU") =>
    Landmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands: options.maxHands ?? 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  let landmarker: HandLandmarker;
  try {
    landmarker = await make(options.delegate ?? "GPU");
  } catch {
    landmarker = await make("CPU");
  }
  return {
    detect(source, timestampMs) {
      const result = landmarker.detectForVideo(source as never, timestampMs);
      return result.landmarks
        .map((image, index): TrackedHand | null => {
          const handedness = result.handedness[index]?.[0];
          if (image.length < LANDMARK_COUNT) return null;
          return {
            modelHandedness: handedness?.categoryName === "Right" ? "Right" : "Left",
            score: handedness?.score ?? 0,
            image: toPoints(image),
            world: toPoints(result.worldLandmarks[index]),
          };
        })
        .filter((hand): hand is TrackedHand => hand !== null);
    },
    close: () => landmarker.close(),
  };
}
