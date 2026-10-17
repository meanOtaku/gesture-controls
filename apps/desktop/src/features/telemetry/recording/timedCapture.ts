/**
 * A timed capture is asked for by the recorder page and carried out by `RecordingTimer`, which stays mounted whatever tab
 * is showing. The request is just a number waiting to be picked up when the first sample lands.
 */
let pendingSeconds: number | null = null;
/** The running capture's stop time (wall clock, ms) and length, while its timer is armed. */
let running: { deadlineMs: number; totalSeconds: number } | null = null;

export const timedCapture = {
  /** Asks for the next recording to stop by itself after `seconds`. */
  request(seconds: number): void {
    pendingSeconds = seconds;
  },
  /** Takes the waiting request, if any, so it is only ever acted on once. */
  take(): number | null {
    const seconds = pendingSeconds;
    pendingSeconds = null;
    return seconds;
  },
  /** Says when the running capture will stop, once its timer is armed; null once it has stopped or been cancelled. */
  setRunning(next: { deadlineMs: number; totalSeconds: number } | null): void {
    running = next;
  },
  /** When the running capture will stop, for the countdown; null when no timer is armed. */
  running(): { deadlineMs: number; totalSeconds: number } | null {
    return running;
  },
  /** For tests. */
  reset(): void {
    pendingSeconds = null;
    running = null;
  },
};
