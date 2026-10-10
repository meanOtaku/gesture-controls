import { physicalHand, type CameraSlot, type HandFrame } from "../camera/handTypes";
import type { MeasureSample } from "./calibration";
import type { HandChoice } from "./definition";
import { sampleFrame } from "./sampling";

export type CalibrationStep = "ready" | "getReady" | "positive" | "getReadyNegative" | "negative" | "done";

export const COUNTDOWN_MS = 3000;
export const POSITIVE_MS = 4000;
export const NEGATIVE_MS = 7000;

/** How long each recording lasts, in seconds, for the choices offered in the editor. */
export const GESTURE_SECONDS = [4, 8, 15, 30] as const;
export const REST_SECONDS = [7, 15, 30, 60] as const;

export interface RecordLengths {
  positiveMs: number;
  negativeMs: number;
}

export interface SessionSnapshot {
  step: CalibrationStep;
  /** Seconds left in the current countdown or recording. */
  remainingMs: number;
  positive: MeasureSample[];
  negative: MeasureSample[];
  /** Frames in the current recording with no matching hand in view (not kept). */
  missedFrames: number;
  /** Why frames were not kept, over the whole run. */
  skipped: SkipReasons;
}

export interface SkipReasons {
  /** The camera found no hand at all. */
  noHand: number;
  /** A hand was found, but not the one chosen for this gesture. */
  otherHand: number;
  /** A hand was found but its shape could not be measured. */
  unmeasurable: number;
}

/**
 * Walks a person through recording the two kinds of frames a calibration needs: the gesture held, and everything else.
 * Driven by `tick` (the clock) and `onFrame` (the camera), so it can be tested without either.
 */
export class CalibrationSession {
  private step: CalibrationStep = "ready";
  private stepStartedMs = 0;
  private positive: MeasureSample[] = [];
  private negative: MeasureSample[] = [];
  private missed = 0;
  private skipped: SkipReasons = { noHand: 0, otherHand: 0, unmeasurable: 0 };
  /** The last frame taken from each camera, since each counts its own frames from zero. */
  private lastFrameIndex: Record<CameraSlot, number> = { primary: -1, secondary: -1 };

  constructor(private readonly hand: HandChoice, private readonly lengths: RecordLengths = { positiveMs: POSITIVE_MS, negativeMs: NEGATIVE_MS }) {}

  start(nowMs: number): void {
    this.positive = [];
    this.negative = [];
    this.missed = 0;
    this.skipped = { noHand: 0, otherHand: 0, unmeasurable: 0 };
    this.enter("getReady", nowMs);
  }

  reset(): void {
    this.step = "ready";
    this.positive = [];
    this.negative = [];
    this.missed = 0;
  }

  private enter(step: CalibrationStep, nowMs: number): void {
    this.step = step;
    this.stepStartedMs = nowMs;
    this.missed = 0;
  }

  private duration(): number {
    switch (this.step) {
      case "getReady": case "getReadyNegative": return COUNTDOWN_MS;
      case "positive": return this.lengths.positiveMs;
      case "negative": return this.lengths.negativeMs;
      default: return 0;
    }
  }

  /** Moves on when a step's time is up. */
  tick(nowMs: number): void {
    if (this.duration() === 0 || nowMs - this.stepStartedMs < this.duration()) return;
    const next: Record<string, CalibrationStep> = { getReady: "positive", positive: "getReadyNegative", getReadyNegative: "negative", negative: "done" };
    this.enter(next[this.step], nowMs);
  }

  /** One frame from one camera; frames from both cameras are pooled into the same recording. */
  onFrame(frame: HandFrame, slot: CameraSlot = "primary"): void {
    if (frame.frameIndex === this.lastFrameIndex[slot]) return;
    this.lastFrameIndex[slot] = frame.frameIndex;
    if (this.step !== "positive" && this.step !== "negative") return;
    const sample = sampleFrame(frame, this.hand);
    if (!sample) {
      this.missed += 1;
      if (frame.hands.length === 0) this.skipped.noHand += 1;
      else if (this.hand !== "either" && !frame.hands.some((h) => physicalHand(h).toLowerCase() === this.hand)) this.skipped.otherHand += 1;
      else this.skipped.unmeasurable += 1;
      return;
    }
    (this.step === "positive" ? this.positive : this.negative).push(sample);
  }

  snapshot(nowMs: number): SessionSnapshot {
    const duration = this.duration();
    return {
      step: this.step,
      remainingMs: duration === 0 ? 0 : Math.max(0, duration - (nowMs - this.stepStartedMs)),
      positive: this.positive,
      negative: this.negative,
      missedFrames: this.missed,
      skipped: { ...this.skipped },
    };
  }
}
