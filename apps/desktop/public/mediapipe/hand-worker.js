/*
 * Runs MediaPipe's hand landmarker off the page's thread, so detection never makes the page or the picture stutter.
 * A classic worker (not a module) because MediaPipe loads its runtime with importScripts.
 *
 * Messages in:  { type: "init", maxHands, delegate, modelUrl, wasmUrl }
 *               { type: "detect", id, bitmap, timestampMs }   (the bitmap is handed over and closed here)
 *               { type: "close" }
 * Messages out: { type: "ready", delegate } | { type: "failed", message }
 *               { type: "result", id, hands, ms } | { type: "error", id, message }
 */
importScripts("/mediapipe/vision_bundle.js");

let landmarker = null;

const points = (list) => (list || []).slice(0, 21).map((p) => ({ x: p.x, y: p.y, z: p.z }));

async function make(fileset, options, delegate) {
  return Vision.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: options.modelUrl, delegate },
    runningMode: "VIDEO",
    numHands: options.maxHands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

self.onmessage = async (event) => {
  const message = event.data;
  if (message.type === "init") {
    try {
      const fileset = await Vision.FilesetResolver.forVisionTasks(message.wasmUrl);
      let delegate = message.delegate;
      try {
        landmarker = await make(fileset, message, delegate);
      } catch (error) {
        delegate = "CPU";
        landmarker = await make(fileset, message, delegate);
      }
      self.postMessage({ type: "ready", delegate });
    } catch (error) {
      self.postMessage({ type: "failed", message: String((error && error.message) || error) });
    }
  } else if (message.type === "detect") {
    const started = performance.now();
    try {
      const result = landmarker.detectForVideo(message.bitmap, message.timestampMs);
      const hands = result.landmarks
        .map((image, index) => {
          const handedness = result.handedness[index] && result.handedness[index][0];
          if (image.length < 21) return null;
          return {
            modelHandedness: handedness && handedness.categoryName === "Right" ? "Right" : "Left",
            score: handedness ? handedness.score : 0,
            image: points(image),
            world: points(result.worldLandmarks[index]),
          };
        })
        .filter((hand) => hand !== null);
      self.postMessage({ type: "result", id: message.id, hands, ms: performance.now() - started });
    } catch (error) {
      self.postMessage({ type: "error", id: message.id, message: String((error && error.message) || error) });
    } finally {
      if (message.bitmap && message.bitmap.close) message.bitmap.close();
    }
  } else if (message.type === "close") {
    if (landmarker) landmarker.close();
    landmarker = null;
    self.close();
  }
};
