import { clockSync } from "./clockSync";
import type { CameraSlot } from "./handTypes";
import { CameraController, type RecordingPhase } from "./cameraController";
import { createMediapipeDetector } from "./mediapipeDetector";
import { telemetryStore } from "../telemetry/store/telemetryStore";

/**
 * The app's cameras. The primary is created the first time something asks for it and lives for the whole session, so a
 * recording keeps its pictures when you leave the page that turned it on. The optional secondary is a separate source:
 * it has its own picture and its own hand detector, and shares only the browser clock.
 */
const controllers: Partial<Record<CameraSlot, CameraController>> = {};

function createController(): CameraController {
  return new CameraController({
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

export function getCameraController(slot: CameraSlot = "primary"): CameraController {
  return (controllers[slot] ??= createController());
}

/** Keeps each camera's list of devices current when one is plugged in or removed. */
export function watchCameraDevices(): () => void {
  const devices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!devices?.addEventListener) return () => undefined;
  const refresh = () => void Promise.all(Object.values(controllers).map((controller) => controller.refreshDevices()));
  devices.addEventListener("devicechange", refresh);
  return () => devices.removeEventListener("devicechange", refresh);
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
