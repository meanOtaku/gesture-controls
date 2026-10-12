/**
 * Puts a sensor's own timestamps on the clock its samples reach us through: here, the Samsung SDK's clock (pulse samples)
 * onto the watch's `elapsedRealtimeNanos` clock that every other watch message is stamped with.
 *
 * A batch is sent shortly after its newest sample was taken, so `sentAt - newestSampleTime` is the offset between the two
 * clocks plus a wait that is never negative. The smallest value over the last 30 seconds is the best estimate of the
 * offset (the batch that waited least; the window lets a slow drift be followed), and that one estimate is applied to
 * every sample. Placing each batch's newest sample at its own send time instead, as before, moved whole batches by however
 * long each one happened to wait, which made the pulse samples' spacing jitter by tens of milliseconds.
 *
 * The same rule as the camera's `ClockSync`; the Rust runtime's `clock::ClockMap` does the same for live windows.
 */

const WINDOW_NS = 30_000_000_000;
/** A gap this much bigger than the estimate is not a slow batch but a clock that jumped: start again from it. */
const JUMP_NS = 1_000_000_000;

interface Observation {
  referenceNs: number;
  deltaNs: number;
}

export class SourceClockMap {
  /** The recent observations whose delta could still be the smallest, oldest first, deltas increasing. */
  private candidates: Observation[] = [];

  /** `sourceNs` is the newest sample's own time; `referenceNs` is when its batch was sent, on the clock to map onto. */
  observe(sourceNs: number, referenceNs: number): void {
    if (!Number.isFinite(sourceNs) || !Number.isFinite(referenceNs)) return;
    const deltaNs = referenceNs - sourceNs;
    const current = this.offsetNs();
    if (current !== null && deltaNs - current > JUMP_NS) this.candidates = [];
    while (this.candidates.length > 0 && this.candidates[this.candidates.length - 1].deltaNs >= deltaNs) this.candidates.pop();
    this.candidates.push({ referenceNs, deltaNs });
    while (this.candidates[0].referenceNs < referenceNs - WINDOW_NS) this.candidates.shift();
  }

  /** Add to a source time to get the reference clock's time; null before anything was observed. */
  offsetNs(): number | null {
    return this.candidates.length > 0 ? this.candidates[0].deltaNs : null;
  }

  /**
   * `sourceNs` on the reference clock: a plain shift, so samples keep their own order and spacing. (When the estimate
   * improves, a batch can land a little before the end of the previous one; the recorder keeps its rows sorted.)
   */
  map(sourceNs: number): number | null {
    const offset = this.offsetNs();
    return offset === null ? null : sourceNs + offset;
  }

  reset(): void {
    this.candidates = [];
  }
}
