import { invoke } from "@tauri-apps/api/core";

/**
 * Vibration bursts like the volume knob's, for an everyday-noise session: while the knob turns, the desktop buzzes the
 * watch for 20 ms at most every 125 ms (`overlay.rs`), and a buzz shakes the very sensors the gesture models read. A
 * recording with these bursts and no gesture teaches a model that a buzz is not a pinch. Each burst lasts 1 to 3 s, as a
 * turn does, with 4 to 12 s of quiet between, at random so the model cannot learn a rhythm. Every buzz sent is logged
 * by the desktop and saved with the recording (`haptics.csv`).
 */
export const KNOB_PULSE_MS = 20;
export const KNOB_PULSE_EVERY_MS = 125;
export const KNOB_GAP_MS: readonly [number, number] = [4_000, 12_000];
export const KNOB_BURST_MS: readonly [number, number] = [1_000, 3_000];

const between = ([low, high]: readonly [number, number], random: () => number) => low + (high - low) * random();

export interface KnobBuzzDeps {
  random?: () => number;
  buzz?: (durationMs: number) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** Starts the bursts; the function returned stops them (and never buzzes again once called). */
export function startKnobBuzz({
  random = Math.random,
  buzz = (durationMs) => void invoke("buzz_watch", { durationMs, source: "noise-session" }).catch(() => undefined),
  setTimer = (run, ms) => setTimeout(run, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: KnobBuzzDeps = {}): () => void {
  let stopped = false;
  let timer: unknown = null;
  const schedule = (run: () => void, ms: number) => {
    if (!stopped) timer = setTimer(run, ms);
  };
  const burst = (left: number) => {
    if (stopped) return;
    buzz(KNOB_PULSE_MS);
    if (left > 1) schedule(() => burst(left - 1), KNOB_PULSE_EVERY_MS);
    else schedule(() => burst(Math.max(1, Math.round(between(KNOB_BURST_MS, random) / KNOB_PULSE_EVERY_MS))), between(KNOB_GAP_MS, random));
  };
  schedule(() => burst(Math.max(1, Math.round(between(KNOB_BURST_MS, random) / KNOB_PULSE_EVERY_MS))), between(KNOB_GAP_MS, random));
  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
  };
}
