/** Measuring how far the head comfortably turns, for a pointer that follows the head. */

export const MIN_HEAD_RANGE_DEGREES = 5;
export const MAX_HEAD_RANGE_DEGREES = 180;

/** The head's yaw and pitch now and the furthest each has gone, in degrees from where measuring began. */
export interface HeadSweep {
  yaw: { now: number; min: number; max: number };
  pitch: { now: number; min: number; max: number };
}

const shortest = (from: number, to: number) => ((((to - from + 540) % 360) + 360) % 360) - 180;

/** Follows the head's yaw and pitch from the first sample, carrying the yaw on across the ±180° seam. */
export class HeadRangeMeter {
  private first: { yaw: number; pitch: number } | null = null;
  private lastYaw = 0;
  private yaw = 0;
  private sweep: HeadSweep = { yaw: { now: 0, min: 0, max: 0 }, pitch: { now: 0, min: 0, max: 0 } };

  observe(yawDeg: number, pitchDeg: number): HeadSweep {
    if (!Number.isFinite(yawDeg) || !Number.isFinite(pitchDeg)) return this.current;
    if (!this.first) {
      this.first = { yaw: yawDeg, pitch: pitchDeg };
      this.lastYaw = yawDeg;
      return this.current;
    }
    this.yaw += shortest(this.lastYaw, yawDeg);
    this.lastYaw = yawDeg;
    const pitch = pitchDeg - this.first.pitch;
    const { yaw: y, pitch: p } = this.sweep;
    this.sweep = {
      yaw: { now: this.yaw, min: Math.min(y.min, this.yaw), max: Math.max(y.max, this.yaw) },
      pitch: { now: pitch, min: Math.min(p.min, pitch), max: Math.max(p.max, pitch) },
    };
    return this.current;
  }

  get current(): HeadSweep {
    return this.sweep;
  }
}

/** The range across and up and down that a sweep measured, each at most the largest a recipe takes. */
export function headRangeOf(sweep: HeadSweep): { across: number; up: number } {
  const span = (axis: { min: number; max: number }) => Math.min(axis.max - axis.min, MAX_HEAD_RANGE_DEGREES);
  return { across: span(sweep.yaw), up: span(sweep.pitch) };
}
