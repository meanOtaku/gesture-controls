import { SLOW_FPS } from "./cameraController";

/** A warning only appears once the rate has stayed low this long, so a brief dip does not flash it. */
export const SLOW_AFTER_MS = 3000;
/** And only goes once the rate is back up to here, a little above the level that raised it, so it does not flicker around 15. */
export const RECOVERED_FPS = 18;

export interface SlowState {
  slow: boolean;
  /** When the rate first dropped below the limit (while not yet slow). */
  since: number | null;
}

export const NOT_SLOW: SlowState = { slow: false, since: null };

/** The next state given the camera's current rate (null when it is not measured: off, or no pictures yet). */
export function nextSlowState(state: SlowState, fps: number | null, now: number): SlowState {
  if (fps === null || fps <= 0) return NOT_SLOW;
  if (state.slow) return fps >= RECOVERED_FPS ? NOT_SLOW : state;
  if (fps >= SLOW_FPS) return state.since === null ? state : NOT_SLOW;
  const since = state.since ?? now;
  return now - since >= SLOW_AFTER_MS ? { slow: true, since } : { slow: false, since };
}
