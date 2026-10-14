import type { GestureRecognizer, HandLandmarker } from "@mediapipe/tasks-vision";
import { pretrainedReading } from "./pretrained";
import { LANDMARK_COUNT, type HandDetector, type Point3, type TrackedHand } from "./handTypes";

/** Where the runtime and the model are served from: the app's own files, never the network. */
export const MEDIAPIPE_WASM_BASE = "/mediapipe/wasm";
export const HAND_MODEL_URL = "/mediapipe/hand_landmarker.task";
/** The same hand landmarks plus a pretrained reading of seven gestures, in one pass. Tried first; the plain landmarker is the fallback. */
export const GESTURE_MODEL_URL = "/mediapipe/gesture_recognizer.task";

export interface DetectorOptions {
  maxHands?: number;
  /** Tried first; the detector falls back to the CPU if the graphics one cannot start. */
  delegate?: "GPU" | "CPU";
}

const toPoints = (points: { x: number; y: number; z: number }[] | undefined): Point3[] =>
  (points ?? []).slice(0, LANDMARK_COUNT).map(({ x, y, z }) => ({ x, y, z }));

type Recognition = Pick<ReturnType<GestureRecognizer["recognizeForVideo"]>, "landmarks" | "worldLandmarks" | "handedness" | "gestures">;

function handsFrom(result: Recognition | ReturnType<HandLandmarker["detectForVideo"]>): TrackedHand[] {
  const gestures = "gestures" in result ? result.gestures : [];
  return result.landmarks
    .map((image, index): TrackedHand | null => {
      const handedness = result.handedness[index]?.[0];
      if (image.length < LANDMARK_COUNT) return null;
      const pretrained = pretrainedReading(gestures[index]);
      return {
        modelHandedness: handedness?.categoryName === "Right" ? "Right" : "Left",
        score: handedness?.score ?? 0,
        image: toPoints(image),
        world: toPoints(result.worldLandmarks[index]),
        ...(pretrained ? { pretrained } : {}),
      };
    })
    .filter((hand): hand is TrackedHand => hand !== null);
}

/**
 * Loads MediaPipe's hand model on the page's thread: the Gesture Recognizer (hand landmarks plus a pretrained reading of
 * seven gestures), or, if that cannot load, the plain Hand Landmarker. Throws with a plain reason if neither can load.
 */
export async function createMediapipeDetector(options: DetectorOptions = {}): Promise<HandDetector> {
  // Loaded only when the camera is first turned on, so the app's own start-up does not carry it.
  const { FilesetResolver, HandLandmarker: Landmarker, GestureRecognizer: Recognizer } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
  const settings = {
    runningMode: "VIDEO" as const,
    numHands: options.maxHands ?? 2,
  };
  const confidences = { minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 };
  type Runner = { detectForVideo(source: never, timestampMs: number): Recognition | ReturnType<HandLandmarker["detectForVideo"]>; close(): void };
  const make = async (delegate: "GPU" | "CPU", pretrained: boolean): Promise<Runner> => {
    if (!pretrained) {
      const landmarker = await Landmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate }, ...settings, ...confidences });
      return { detectForVideo: (source, ms) => landmarker.detectForVideo(source, ms), close: () => landmarker.close() };
    }
    const recognizer = await Recognizer.createFromOptions(fileset, { baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate }, ...settings, ...confidences });
    return { detectForVideo: (source, ms) => recognizer.recognizeForVideo(source, ms), close: () => recognizer.close() };
  };
  let runner: Runner;
  let delegateUsed: "GPU" | "CPU" = options.delegate ?? "GPU";
  let pretrained = true;
  try {
    runner = await make(delegateUsed, true);
  } catch {
    try {
      delegateUsed = "CPU";
      runner = await make("CPU", true);
    } catch {
      pretrained = false;
      runner = await make(delegateUsed, false).catch(() => make("CPU", false));
    }
  }
  return {
    description: `${delegateUsed === "GPU" ? "graphics chip" : "processor"}, page thread${pretrained ? "" : ", no pretrained gestures"}`,
    detect(source, timestampMs) {
      return handsFrom(runner.detectForVideo(source as never, timestampMs));
    },
    close: () => runner.close(),
  };
}

const WORKER_URL = "/mediapipe/hand-worker.js";
const WORKER_START_TIMEOUT_MS = 30_000;

type WorkerReply =
  | { type: "ready"; delegate: "GPU" | "CPU"; pretrained?: boolean }
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

  const started = await new Promise<{ delegate: "GPU" | "CPU"; pretrained: boolean }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the hand worker did not start in time")), WORKER_START_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const message = event.data;
      if (message.type === "ready") {
        clearTimeout(timer);
        resolve({ delegate: message.delegate, pretrained: message.pretrained === true });
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
      gestureModelUrl: new URL(GESTURE_MODEL_URL, self.location.href).href,
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
    description: `${started.delegate === "GPU" ? "graphics chip" : "processor"}, background thread${started.pretrained ? "" : ", no pretrained gestures"}`,
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
