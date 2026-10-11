import type { RecordingSource } from "../../shared/tauri/recordingBundle";
import { type SyncPair } from "./clockSync";
import { CLOCK_SYNC_FILE, HAND_LANDMARKS_FILE, HAND_LANDMARKS_FILE_2, clockSyncCsv, frameToCsvRows, handLandmarksHeader } from "./handLandmarkCsv";
import { type CameraSlot, type HandDetector, type HandFrame, type TrackedHand } from "./handTypes";

/** Frames kept from before a recording starts, so the first moments of the recording have a picture. */
export const PREROLL_MS = 3000;
/** The most frames one recording keeps (about 17 minutes at 30 frames a second). Beyond it the recording says it was cut short. */
export const MAX_RECORDED_FRAMES = 30_000;
/** Extra camera time saved either side of the recording, so labels near its ends have a picture. */
export const EVIDENCE_MARGIN_MS = 1000;
/** How often pages hear about a new frame. The detector and `subscribeFrames` run at the camera's own rate. */
const UI_INTERVAL_MS = 50;
/** Pictures a detector on another thread may be working on at once. */
export const MAX_IN_FLIGHT = 2;
/** "30 frames/s · 12 ms each": how fast the camera is going and how long the hand model takes per picture. */
export function speedLabel(state: Pick<CameraSnapshot, "fps" | "detectMs">, waiting = "waiting for frames"): string {
  if (state.fps <= 0) return waiting;
  return `${state.fps.toFixed(0)} frames/s${state.detectMs > 0 ? ` · ${state.detectMs.toFixed(0)} ms each` : ""}`;
}

/** Below this the picture is too slow for a gesture's start and end to be placed well. */
export const SLOW_FPS = 15;
export const MODEL_NAME = "hand_landmarker.task (float16)";

export type CameraStatus = "off" | "starting" | "on" | "error";
export type RecordingPhase = "idle" | "arming" | "recording" | "saved" | "discarded";

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface CameraSnapshot {
  status: CameraStatus;
  error: string | null;
  devices: CameraDevice[];
  deviceId: string | null;
  fps: number;
  /** How long hand detection takes per picture, in ms (smoothed). Above about 30 the camera cannot keep up with 30 pictures a second. */
  detectMs: number;
  /** What runs the hand model, once the camera is on: "graphics chip, background thread". */
  engine: string | null;
  /** The newest frame, for the live preview. Pages are told about it about 20 times a second; `subscribeFrames` has every one. */
  frame: HandFrame | null;
  /** Whether hand landmarks are saved with recordings. */
  recordLandmarks: boolean;
  collecting: boolean;
  collectedFrames: number;
  truncated: boolean;
}

export interface CameraDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  createDetector(): Promise<HandDetector>;
  createVideo(): HTMLVideoElement;
  /** `performance.now()`. */
  now(): number;
  /** Which camera this is. The second camera saves its landmarks in a file of its own. Default: the primary. */
  slot?: CameraSlot;
  /** The watch/browser clock pairs, for the evidence file. */
  syncPairs(fromMs: number, toMs: number): SyncPair[];
}

interface StoredFrame {
  captureMs: number;
  rows: string[];
  hands: number;
}

export interface CameraEvidence {
  files: Record<string, string>;
  source: RecordingSource;
}

/** A frame found no hand when `hands` is 0; that is evidence too. */
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Owns the camera and the hand detector for the whole app, not for a page: a recording keeps getting pictures when you
 * look at another tab. Pages only watch it. While a recording runs it keeps every frame's landmark rows (never the
 * picture); when not recording it keeps only the last few seconds.
 */
export class CameraController {
  readonly video: HTMLVideoElement;
  private snapshot: CameraSnapshot = {
    status: "off", error: null, devices: [], deviceId: null, fps: 0, detectMs: 0, engine: null, frame: null,
    recordLandmarks: true, collecting: false, collectedFrames: 0, truncated: false,
  };
  private listeners = new Set<() => void>();
  private frameListeners = new Set<(frame: HandFrame) => void>();
  private lastNotifyMs = -Infinity;
  private detectEma = 0;
  private stream: MediaStream | null = null;
  private detector: HandDetector | null = null;
  private generation = 0;
  /** Pictures sent to a detector on another thread and not yet answered. */
  private inFlight = 0;
  /** Whether a callback for the next picture is already waiting. */
  private framePending = false;
  private frameIndex = 0;
  private lastTimestampMs = -1;
  private lastCaptureMs = 0;
  private fpsEma = 0;
  private preroll: StoredFrame[] = [];
  private session: StoredFrame[] = [];
  private captureTimeSource = { captureTime: 0, callback: 0 };
  private handFrames = 0;
  private picture: { width: number; height: number } = { width: 0, height: 0 };

  constructor(private readonly deps: CameraDeps) {
    this.video = deps.createVideo();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = (): CameraSnapshot => this.snapshot;

  /**
   * Every frame, as soon as it is detected and not through page rendering, so what decides on gestures never misses one
   * when the pages are busy drawing. Use this, not `subscribe`, for anything that must see all frames.
   */
  readonly subscribeFrames = (listener: (frame: HandFrame) => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  };

  private set(patch: Partial<CameraSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.lastNotifyMs = -Infinity;
    this.listeners.forEach((listener) => listener());
  }

  /** A new frame: the snapshot is current at once, but pages are told at most every `UI_INTERVAL_MS`, so drawing keeps up. */
  private setFrame(frame: HandFrame, fps: number, detectMs: number): void {
    this.snapshot = { ...this.snapshot, frame, fps, detectMs };
    if (frame.captureMs - this.lastNotifyMs < UI_INTERVAL_MS) return;
    this.lastNotifyMs = frame.captureMs;
    this.listeners.forEach((listener) => listener());
  }

  async refreshDevices(): Promise<void> {
    try {
      const all = await this.deps.enumerateDevices();
      const cameras = all.filter((device) => device.kind === "videoinput").map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
      }));
      this.set({ devices: cameras });
    } catch {
      // Listing is a convenience; turning the camera on still works.
    }
  }

  /** Chooses a camera: switches to it now when the camera is on, otherwise remembers it for the next time it is turned on. */
  selectDevice(deviceId: string): void {
    if (this.snapshot.status === "on" || this.snapshot.status === "starting") void this.enable(deviceId);
    else this.set({ deviceId });
  }

  setRecordLandmarks(record: boolean): void {
    this.set({ recordLandmarks: record });
  }

  /** Turns the camera on (or switches to another). Everything that can go wrong ends as an `error` with its reason. */
  async enable(deviceId?: string): Promise<void> {
    this.stopEverything();
    const generation = ++this.generation;
    this.inFlight = 0;
    this.framePending = false;
    this.set({ status: "starting", error: null, frame: null, fps: 0, detectMs: 0, deviceId: deviceId ?? this.snapshot.deviceId });
    try {
      const wanted = deviceId ?? this.snapshot.deviceId;
      const stream = await this.deps.getUserMedia({
        video: { ...(wanted ? { deviceId: { exact: wanted } } : {}), width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      if (generation !== this.generation) return stream.getTracks().forEach((track) => track.stop());
      this.stream = stream;
      this.video.srcObject = stream;
      this.video.muted = true;
      await this.video.play();
      let detector: HandDetector;
      try {
        detector = await this.deps.createDetector();
      } catch (error) {
        throw new Error(`The hand model could not be loaded: ${message(error)}`);
      }
      if (generation !== this.generation) return detector.close();
      this.detector = detector;
      this.set({ engine: detector.description ?? null });
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings?.() ?? {};
      this.picture = { width: settings.width ?? this.video.videoWidth, height: settings.height ?? this.video.videoHeight };
      await this.refreshDevices();
      this.set({ status: "on", deviceId: settings.deviceId ?? wanted ?? null });
      this.scheduleFrame(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.stopEverything();
      this.set({ status: "error", error: this.explain(error) });
    }
  }

  disable(): void {
    this.generation += 1;
    this.inFlight = 0;
    this.framePending = false;
    this.stopEverything();
    this.detectEma = 0;
    this.set({ status: "off", error: null, frame: null, fps: 0, detectMs: 0, engine: null });
  }

  private explain(error: unknown): string {
    const name = (error as { name?: string } | null)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "The camera was blocked. Allow camera access for this app in your system's privacy settings, then turn the camera on again.";
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found. Connect one, or choose another from the list.";
    if (name === "NotReadableError") return "The camera is in use by another app. Close it and try again.";
    return message(error);
  }

  private stopEverything(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.detector?.close();
    this.detector = null;
    this.preroll = [];
  }

  private scheduleFrame(generation: number): void {
    if (this.framePending) return;
    this.framePending = true;
    const video = this.video;
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback((now, metadata) => this.onFrame(generation, now, metadata?.captureTime));
    } else {
      requestAnimationFrame((now) => this.onFrame(generation, now, undefined));
    }
  }

  private onFrame(generation: number, callbackMs: number, captureTime: number | undefined): void {
    if (generation !== this.generation || !this.detector) return;
    this.framePending = false;
    const fail = (error: unknown) => {
      if (generation !== this.generation) return;
      this.stopEverything();
      this.set({ status: "error", error: `Hand tracking stopped: ${message(error)}` });
    };
    let working: Promise<void> | void;
    try {
      working = this.process(callbackMs, captureTime);
    } catch (error) {
      return fail(error);
    }
    if (working) {
      // A detector on another thread. Copying a picture across takes time on this thread too, so the next picture is
      // taken while this one is still being worked on (at most `MAX_IN_FLIGHT` at once): without that, a detector that
      // needs a little more than one frame period misses every other picture and the rate halves. Beyond that, pictures
      // never queue up: the next is taken only when one is answered, so the hands belong to a recent picture.
      this.inFlight += 1;
      working.then(
        () => {
          if (generation !== this.generation) return;
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.scheduleFrame(generation);
        },
        (error) => {
          if (generation === this.generation) this.inFlight = Math.max(0, this.inFlight - 1);
          fail(error);
        },
      );
      if (this.inFlight < MAX_IN_FLIGHT) this.scheduleFrame(generation);
      return;
    }
    this.scheduleFrame(generation);
  }

  /**
   * Detects the hands in the current picture and files the result. Public so a test can drive it frame by frame. Returns
   * a promise when the detector answers later, nothing when it answered at once.
   */
  process(callbackMs: number, captureTime?: number): Promise<void> | void {
    const detector = this.detector;
    if (!detector) return;
    const generation = this.generation;
    const captureMs = typeof captureTime === "number" && Number.isFinite(captureTime) ? captureTime : callbackMs;
    this.captureTimeSource[typeof captureTime === "number" ? "captureTime" : "callback"] += 1;
    // MediaPipe wants a strictly increasing whole-millisecond clock.
    const timestamp = Math.max(Math.round(captureMs), this.lastTimestampMs + 1);
    this.lastTimestampMs = timestamp;
    const started = performance.now();
    const found = detector.detect(this.video, timestamp);
    if (found instanceof Promise) {
      return found.then((hands) => {
        if (generation === this.generation) this.finishFrame(captureMs, hands, performance.now() - started);
      });
    }
    this.finishFrame(captureMs, found, performance.now() - started);
  }

  private finishFrame(captureMs: number, hands: TrackedHand[], took: number): void {
    this.detectEma = this.detectEma === 0 ? took : this.detectEma * 0.9 + took * 0.1;
    const frame: HandFrame = { frameIndex: this.frameIndex, captureMs, hands };
    this.frameIndex += 1;
    if (hands.length > 0) this.handFrames += 1;
    if (this.lastCaptureMs > 0) {
      const dt = captureMs - this.lastCaptureMs;
      if (dt > 0) this.fpsEma = this.fpsEma === 0 ? 1000 / dt : this.fpsEma * 0.9 + (1000 / dt) * 0.1;
    }
    this.lastCaptureMs = captureMs;
    this.file({ captureMs, rows: frameToCsvRows(frame), hands: hands.length });
    this.setFrame(frame, this.fpsEma, this.detectEma);
    this.frameListeners.forEach((listener) => {
      try {
        listener(frame);
      } catch {
        // One listener's failure must not stop the camera or the others.
      }
    });
  }

  private file(stored: StoredFrame): void {
    if (this.snapshot.collecting) {
      if (this.session.length >= MAX_RECORDED_FRAMES) {
        if (!this.snapshot.truncated) this.set({ truncated: true });
        return;
      }
      this.session.push(stored);
      if (this.session.length % 30 === 0) this.set({ collectedFrames: this.session.length });
      return;
    }
    this.preroll.push(stored);
    while (this.preroll.length > 0 && stored.captureMs - this.preroll[0].captureMs > PREROLL_MS) this.preroll.shift();
  }

  /** Told how the recording is going, so the camera keeps (or drops) frames to match. */
  syncRecording(phase: RecordingPhase): void {
    const active = phase === "arming" || phase === "recording";
    if (active && !this.snapshot.collecting && this.snapshot.recordLandmarks && this.snapshot.status === "on") {
      this.session = [...this.preroll];
      this.set({ collecting: true, collectedFrames: this.session.length, truncated: false });
    } else if (!active && this.snapshot.collecting) {
      // What was collected stays until the next recording starts, because the bundle is built just after the stop.
      this.set({ collecting: false, collectedFrames: this.session.length });
    }
    if (phase === "discarded" || phase === "idle") {
      if (this.session.length > 0) {
        this.session = [];
        this.set({ collectedFrames: 0, truncated: false });
      }
    }
  }

  /**
   * The camera evidence for a recording between `startMs` and `endMs` on the browser clock, ready to be saved with it,
   * or null if there is none (the camera was off, landmarks were switched off, or no frame fell in the window).
   */
  evidence(startMs: number, endMs: number): CameraEvidence | null {
    const second = this.deps.slot === "secondary";
    if (!this.snapshot.recordLandmarks && this.session.length === 0) return null;
    const from = startMs - EVIDENCE_MARGIN_MS;
    const to = endMs + EVIDENCE_MARGIN_MS;
    const frames = this.session.filter((frame) => frame.captureMs >= from && frame.captureMs <= to);
    if (frames.length === 0) return null;
    const rows = frames.flatMap((frame) => frame.rows);
    const handsSeen = frames.filter((frame) => frame.hands > 0).length;
    const firstMs = frames[0].captureMs;
    const lastMs = frames[frames.length - 1].captureMs;
    return {
      files: {
        [second ? HAND_LANDMARKS_FILE_2 : HAND_LANDMARKS_FILE]: [handLandmarksHeader(), ...rows].join("\n"),
        [CLOCK_SYNC_FILE]: clockSyncCsv(this.deps.syncPairs(from, to)),
      },
      source: {
        source_id: second ? "camera_hand_landmarks_2" : "camera_hand_landmarks",
        configuration: {
          camera: second ? "second" : "first",
          model: MODEL_NAME,
          runtime: "@mediapipe/tasks-vision",
          frames: frames.length,
          frames_with_a_hand: handsSeen,
          first_frame_capture_ms: firstMs,
          last_frame_capture_ms: lastMs,
          margin_ms: EVIDENCE_MARGIN_MS,
          truncated: this.snapshot.truncated,
          picture: this.picture,
          capture_time_from_camera_frames: this.captureTimeSource.captureTime,
          capture_time_from_callback: this.captureTimeSource.callback,
          // The model's own label, saved as reported; whether it matches the physical hand is a setting, not assumed here.
          handedness_convention: "model_label_assumes_mirrored_picture",
          clock: "browser performance.now(); line up with the watch using clock_sync.csv",
        },
      },
    };
  }
}
