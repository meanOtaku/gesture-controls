import { invoke } from "@tauri-apps/api/core";
import type { CameraController } from "../camera/cameraController";
import { clockSync, type ClockSync } from "../camera/clockSync";
import { CLOCK_SYNC_FILE, HAND_LANDMARKS_FILE, clockSyncCsv, frameToCsvRows, handLandmarksHeader } from "../camera/handLandmarkCsv";
import type { HandFrame } from "../camera/handTypes";

/** As long as the miss recorder's own buffer of the watch's signals. */
export const KEEP_MS = 45_000;
/** A little more of the clock pairs than of the frames, so the first frames can be placed too. */
const SYNC_MARGIN_MS = 2_000;

/**
 * What the camera saw lately: the hand landmarks of the last 45 seconds, kept in memory while the camera is on, so a
 * marked miss can be saved with the picture of the hand at every moment of it. Only landmarks, never the picture itself,
 * as in a recording. Nothing is written until a miss is marked.
 */
export class MissCameraBuffer {
  private frames: HandFrame[] = [];

  constructor(private readonly sync: Pick<ClockSync, "pairsBetween"> = clockSync) {}

  push(frame: HandFrame): void {
    // A camera that was turned off and on again counts its frames, and its clock may be ahead of the old frames', from the
    // start: anything not after the last frame begins the buffer again.
    const last = this.frames[this.frames.length - 1];
    if (last && frame.captureMs <= last.captureMs) this.frames = [];
    this.frames.push(frame);
    const oldest = frame.captureMs - KEEP_MS;
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop].captureMs < oldest) drop += 1;
    if (drop > 0) this.frames.splice(0, drop);
  }

  get length(): number {
    return this.frames.length;
  }

  clear(): void {
    this.frames = [];
  }

  /**
   * The camera files for a miss marked at `nowMs` (the browser's clock): the frames of the 45 seconds before it, and the
   * clock pairs that place them among the watch's samples. Null when the camera saw nothing in that time, or the watch
   * sent nothing to place it by.
   */
  files(nowMs: number): Record<string, string> | null {
    const frames = this.frames.filter((frame) => frame.captureMs >= nowMs - KEEP_MS && frame.captureMs <= nowMs);
    if (frames.length === 0) return null;
    const pairs = this.sync.pairsBetween(frames[0].captureMs - SYNC_MARGIN_MS, nowMs);
    if (pairs.length === 0) return null;
    // Frames are numbered from 0 within the file, as a recording's are.
    const first = frames[0].frameIndex;
    const rows = frames.flatMap((frame) => frameToCsvRows({ ...frame, frameIndex: frame.frameIndex - first }));
    return {
      [HAND_LANDMARKS_FILE]: [handLandmarksHeader(), ...rows].join("\n") + "\n",
      [CLOCK_SYNC_FILE]: clockSyncCsv(pairs) + "\n",
    };
  }
}

/** Feeds `buffer` from `camera` for as long as the returned function is not called; a camera turned off empties it. */
export function followCamera(camera: Pick<CameraController, "subscribe" | "subscribeFrames" | "getSnapshot">, buffer: MissCameraBuffer): () => void {
  const stops = [
    camera.subscribeFrames((frame) => { if (frame) buffer.push(frame); }),
    camera.subscribe(() => { if (camera.getSnapshot().status === "off") buffer.clear(); }),
  ];
  return () => stops.forEach((stop) => stop());
}

/** Saves the camera files with the miss's recording. Returns how many files were written. */
export function attachMissCamera(datasetId: string, files: Record<string, string>): Promise<number> {
  return invoke<number>("attach_miss_camera", { id: datasetId, files });
}
