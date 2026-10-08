/**
 * Lines the watch's clock up with the browser's, which is the clock camera frames are stamped with.
 *
 * Each watch sample carries the watch's own timestamp, and arrives here at a time we can read on the browser's clock.
 * `arrival - watchTime` is the offset between the two clocks *plus* however long that sample took to get here, and the
 * delay is never negative. So the smallest value seen recently is the best estimate of the offset: it is the sample that
 * travelled fastest. The spread above that minimum says how jittery the link is, which bounds how well the camera and
 * the watch can be lined up.
 *
 * The estimate is only used to place camera frames among watch samples *afterwards*; the raw pairs are saved with the
 * recording so it can be redone better later.
 */

/** Only the last this-many seconds count, so a slow drift in one clock is followed. */
const WINDOW_MS = 30_000;
/** One saved pair per this many milliseconds: enough to follow drift, small to store. */
const SAVE_EVERY_MS = 200;

export interface SyncPair {
  watchTimestampNs: number;
  browserArrivalMs: number;
}

export interface SyncEstimate {
  /** Add this to a watch time in milliseconds to get the browser's time. */
  offsetMs: number;
  /** How many recent samples it is based on. */
  samples: number;
  /** The 90th-percentile extra delay above the fastest sample: how jittery the link is. */
  jitterMs: number;
}

export class ClockSync {
  private recent: SyncPair[] = [];
  private saved: SyncPair[] = [];
  private lastSavedMs = -Infinity;

  /** Call for every watch sample, with the browser's clock at the moment it arrived. */
  observe(watchTimestampNs: number, browserArrivalMs: number): void {
    if (!Number.isFinite(watchTimestampNs) || !Number.isFinite(browserArrivalMs)) return;
    const pair = { watchTimestampNs, browserArrivalMs };
    this.recent.push(pair);
    const oldest = browserArrivalMs - WINDOW_MS;
    let drop = 0;
    while (drop < this.recent.length && this.recent[drop].browserArrivalMs < oldest) drop += 1;
    if (drop > 0) this.recent.splice(0, drop);
    if (browserArrivalMs - this.lastSavedMs >= SAVE_EVERY_MS) {
      this.saved.push(pair);
      this.lastSavedMs = browserArrivalMs;
    }
  }

  /** Null until there are enough samples to trust. */
  estimate(minSamples = 20): SyncEstimate | null {
    if (this.recent.length < minSamples) return null;
    const delays = this.recent.map((pair) => pair.browserArrivalMs - pair.watchTimestampNs / 1e6);
    const sorted = [...delays].sort((a, b) => a - b);
    const offsetMs = sorted[0];
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    return { offsetMs, samples: this.recent.length, jitterMs: p90 - offsetMs };
  }

  /** A watch time in nanoseconds as a time on the browser's clock, or null without an estimate. */
  toBrowserMs(watchTimestampNs: number): number | null {
    const estimate = this.estimate();
    return estimate ? watchTimestampNs / 1e6 + estimate.offsetMs : null;
  }

  /** The saved pairs whose arrival falls in [fromMs, toMs]. */
  pairsBetween(fromMs: number, toMs: number): SyncPair[] {
    return this.saved.filter((pair) => pair.browserArrivalMs >= fromMs && pair.browserArrivalMs <= toMs);
  }

  reset(): void {
    this.recent = [];
    this.saved = [];
    this.lastSavedMs = -Infinity;
  }
}

/** The one estimator the app feeds from the watch stream. */
export const clockSync = new ClockSync();
