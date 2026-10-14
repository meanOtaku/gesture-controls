/*
 * Runs MediaPipe's gesture recognizer (hand landmarks plus a pretrained reading of seven gestures; the plain hand
 * landmarker if that cannot load) off the page's thread, so detection never makes the page or the picture stutter.
 * A classic worker (not a module) because MediaPipe loads its runtime with importScripts.
 *
 * Messages in:  { type: "init", maxHands, delegate, modelUrl, gestureModelUrl, wasmUrl }
 *               { type: "detect", id, bitmap, timestampMs }   (the bitmap is handed over and closed here)
 *               { type: "close" }
 * Messages out: { type: "ready", delegate, pretrained } | { type: "failed", message }
 *               { type: "result", id, hands, ms } | { type: "error", id, message }
 */
importScripts("/mediapipe/vision_bundle.js");

let landmarker = null;
let pretrained = false;
const KNOWN = ["Closed_Fist", "Open_Palm", "Pointing_Up", "Thumb_Down", "Thumb_Up", "Victory", "ILoveYou"];

const points = (list) => (list || []).slice(0, 21).map((p) => ({ x: p.x, y: p.y, z: p.z }));

async function make(fileset, options, delegate, withGestures) {
  const common = {
    runningMode: "VIDEO",
    numHands: options.maxHands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  if (withGestures) {
    return Vision.GestureRecognizer.createFromOptions(fileset, { baseOptions: { modelAssetPath: options.gestureModelUrl, delegate }, ...common });
  }
  return Vision.HandLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: options.modelUrl, delegate }, ...common });
}

function reading(categories) {
  const best = categories && categories[0];
  if (!best || !KNOWN.includes(best.categoryName)) return undefined;
  return { gesture: best.categoryName, score: best.score || 0 };
}

self.onmessage = async (event) => {
  const message = event.data;
  if (message.type === "init") {
    try {
      const fileset = await Vision.FilesetResolver.forVisionTasks(message.wasmUrl);
      let delegate = message.delegate;
      pretrained = Boolean(message.gestureModelUrl);
      try {
        landmarker = await make(fileset, message, delegate, pretrained);
      } catch (error) {
        delegate = "CPU";
        try {
          landmarker = await make(fileset, message, delegate, pretrained);
        } catch (second) {
          // The pretrained model could not load; the plain landmarker still gives the hands.
          pretrained = false;
          landmarker = await make(fileset, message, delegate, false);
        }
      }
      self.postMessage({ type: "ready", delegate, pretrained });
    } catch (error) {
      self.postMessage({ type: "failed", message: String((error && error.message) || error) });
    }
  } else if (message.type === "detect") {
    const started = performance.now();
    try {
      const result = pretrained
        ? landmarker.recognizeForVideo(message.bitmap, message.timestampMs)
        : landmarker.detectForVideo(message.bitmap, message.timestampMs);
      const hands = result.landmarks
        .map((image, index) => {
          const handedness = result.handedness[index] && result.handedness[index][0];
          if (image.length < 21) return null;
          const hand = {
            modelHandedness: handedness && handedness.categoryName === "Right" ? "Right" : "Left",
            score: handedness ? handedness.score : 0,
            image: points(image),
            world: points(result.worldLandmarks[index]),
          };
          const known = pretrained ? reading(result.gestures && result.gestures[index]) : undefined;
          if (known) hand.pretrained = known;
          return hand;
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
