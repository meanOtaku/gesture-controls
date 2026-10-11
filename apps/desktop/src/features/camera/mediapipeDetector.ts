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
  let delegateUsed: "GPU" | "CPU" = options.delegate ?? "GPU";
  try {
    landmarker = await make(delegateUsed);
  } catch {
    delegateUsed = "CPU";
    landmarker = await make("CPU");
  }
  return {
    description: `${delegateUsed === "GPU" ? "graphics chip" : "processor"}, page thread`,
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

const WORKER_URL = "/mediapipe/hand-worker.js";
const WORKER_START_TIMEOUT_MS = 30_000;

type WorkerReply =
  | { type: "ready"; delegate: "GPU" | "CPU" }
  | { type: "failed"; message: string }
  | { type: "result"; id: number; hands: TrackedHand[]; ms: number }
  | { type: "error"; id: number; message: string };

/**
 * The same hand landmarker, running in a background worker. The page only copies the current picture across
 * (`createImageBitmap`) and gets the hands back, so detection no longer takes the page's thread: the preview, the buttons
 * and the other camera stay smooth. Throws if the worker cannot start, so the caller can fall back to the page-thread one.
 */
export async function createWorkerDetector(options: DetectorOptions = {}): Promise<HandDetector> {
  const worker = new Worker(WORKER_URL);
  const waiting = new Map<number, { resolve: (hands: TrackedHand[]) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let sent: Promise<void> = Promise.resolve();
  let broken: Error | null = null;
  const failAll = (error: Error) => {
    broken = error;
    waiting.forEach((entry) => entry.reject(error));
    waiting.clear();
  };

  const delegate = await new Promise<"GPU" | "CPU">((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the hand worker did not start in time")), WORKER_START_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const message = event.data;
      if (message.type === "ready") {
        clearTimeout(timer);
        resolve(message.delegate);
      } else if (message.type === "failed") {
        clearTimeout(timer);
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(event.message || "the hand worker could not be loaded"));
    };
    worker.postMessage({
      type: "init",
      maxHands: options.maxHands ?? 2,
      delegate: options.delegate ?? "GPU",
      modelUrl: new URL(HAND_MODEL_URL, self.location.href).href,
      wasmUrl: new URL(MEDIAPIPE_WASM_BASE, self.location.href).href,
    });
  }).catch((error) => {
    worker.terminate();
    throw error;
  });

  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const message = event.data;
    if (message.type !== "result" && message.type !== "error") return;
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.type === "result") entry.resolve(message.hands);
    else entry.reject(new Error(message.message));
  };
  worker.onerror = (event) => failAll(new Error(event.message || "the hand worker stopped"));

  return {
    description: `${delegate === "GPU" ? "graphics chip" : "processor"}, background thread`,
    async detect(source, timestampMs) {
      if (broken) throw broken;
      // The picture is copied now (it is the current one) but handed over in the order taken, because the hand model
      // needs its timestamps to increase.
      const copy = createImageBitmap(source as ImageBitmapSource);
      const turn = sent.then(() => copy);
      sent = turn.then(() => undefined, () => undefined);
      const bitmap = await turn;
      return new Promise<TrackedHand[]>((resolve, reject) => {
        const id = (nextId += 1);
        waiting.set(id, { resolve, reject });
        worker.postMessage({ type: "detect", id, bitmap, timestampMs }, [bitmap]);
      });
    },
    close() {
      failAll(new Error("closed"));
      worker.postMessage({ type: "close" });
      setTimeout(() => worker.terminate(), 200);
    },
  };
}
