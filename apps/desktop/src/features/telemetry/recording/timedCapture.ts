/**
 * A timed capture is asked for by the recorder page and carried out by `RecordingTimer`, which stays mounted whatever tab
 * is showing. The request is just a number waiting to be picked up when the first sample lands.
 */
let pendingSeconds: number | null = null;

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
  /** For tests. */
  reset(): void {
    pendingSeconds = null;
  },
};
