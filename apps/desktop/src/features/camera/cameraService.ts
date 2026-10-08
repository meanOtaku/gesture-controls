import { clockSync } from "./clockSync";
import { CameraController, type RecordingPhase } from "./cameraController";
import { createMediapipeDetector } from "./mediapipeDetector";
import { telemetryStore } from "../telemetry/store/telemetryStore";

/**
 * The app's one camera. It is created the first time something asks for it and lives for the whole session, so a
 * recording keeps its pictures when you leave the page that turned the camera on.
 */
let controller: CameraController | null = null;

export function getCameraController(): CameraController {
  if (!controller) {
    controller = new CameraController({
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
      createDetector: async () => {
        const detector = await createMediapipeDetector();
        // The graphics path takes seconds to compile on its first picture; do it now, not in the middle of a gesture.
        const blank = document.createElement("canvas");
        blank.width = blank.height = 64;
        detector.detect(blank, 0);
        return detector;
      },
      createVideo: () => {
        const video = document.createElement("video");
        video.playsInline = true;
        video.muted = true;
        return video;
      },
      now: () => performance.now(),
      syncPairs: (from, to) => clockSync.pairsBetween(from, to),
    });
  }
  return controller;
}

/** Connects the camera to the recorder: it follows the recording's state, and its evidence is saved with each bundle. */
export function bindCameraToRecording(): () => void {
  const camera = getCameraController();
  telemetryStore.setEvidenceProvider((startMs, endMs) => camera.evidence(startMs, endMs));
  const follow = () => camera.syncRecording(telemetryStore.getDatasetRecordingState() as RecordingPhase);
  const unsubscribe = telemetryStore.subscribe(follow);
  follow();
  return () => {
    unsubscribe();
    telemetryStore.setEvidenceProvider(null);
  };
}
