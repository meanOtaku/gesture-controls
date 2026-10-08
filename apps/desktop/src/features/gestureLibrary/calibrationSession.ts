import type { HandFrame } from "../camera/handTypes";
import type { MeasureSample } from "./calibration";
import type { HandChoice } from "./definition";
import { sampleFrame } from "./sampling";

export type CalibrationStep = "ready" | "getReady" | "positive" | "getReadyNegative" | "negative" | "done";

export const COUNTDOWN_MS = 3000;
export const POSITIVE_MS = 4000;
export const NEGATIVE_MS = 7000;

export interface SessionSnapshot {
  step: CalibrationStep;
  /** Seconds left in the current countdown or recording. */
  remainingMs: number;
  positive: MeasureSample[];
  negative: MeasureSample[];
  /** Frames in the current recording with no matching hand in view (not kept). */
  missedFrames: number;
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
  private lastFrameIndex = -1;

  constructor(private readonly hand: HandChoice) {}

  start(nowMs: number): void {
    this.positive = [];
    this.negative = [];
    this.missed = 0;
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
      case "positive": return POSITIVE_MS;
      case "negative": return NEGATIVE_MS;
      default: return 0;
    }
  }

  /** Moves on when a step's time is up. */
  tick(nowMs: number): void {
    if (this.duration() === 0 || nowMs - this.stepStartedMs < this.duration()) return;
    const next: Record<string, CalibrationStep> = { getReady: "positive", positive: "getReadyNegative", getReadyNegative: "negative", negative: "done" };
    this.enter(next[this.step], nowMs);
  }

  onFrame(frame: HandFrame): void {
    if (frame.frameIndex === this.lastFrameIndex) return;
    this.lastFrameIndex = frame.frameIndex;
    if (this.step !== "positive" && this.step !== "negative") return;
    const sample = sampleFrame(frame, this.hand);
    if (!sample) {
      this.missed += 1;
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
    };
  }
}
