import { invoke } from "@tauri-apps/api/core";
import { telemetryStore } from "../store/telemetryStore";
import { CUE_BUZZ_MS, labelAt, planSteps, stepAt, totalMs, type GuidedPlan, type GuidedStep } from "./guidedSession";
import { timedCapture } from "./timedCapture";

/** How often the runner checks the clock: a cue's label starts within this of the cue. */
const TICK_MS = 25;

interface Running {
  steps: GuidedStep[];
  /** When the first sample landed (performance clock); the session's time counts from here. */
  startedAtMs: number | null;
  applied: string | null;
  lastCueIndex: number;
  buzzFailed: boolean;
  timer: ReturnType<typeof setInterval>;
}

export interface GuidedSnapshot {
  steps: GuidedStep[];
  /** Null until the first sample lands. */
  elapsedMs: number | null;
  /** The watch could not be buzzed (not connected, or the browser preview): the cues are on screen only. */
  buzzFailed: boolean;
}

let running: Running | null = null;
const listeners = new Set<() => void>();
let snapshot: GuidedSnapshot | null = null;

function publish() {
  snapshot = running
    ? { steps: running.steps, elapsedMs: running.startedAtMs === null ? null : performance.now() - running.startedAtMs, buzzFailed: running.buzzFailed }
    : null;
  listeners.forEach((listener) => listener());
}

function buzz(session: Running) {
  if (!("__TAURI_INTERNALS__" in window)) {
    session.buzzFailed = true;
    return;
  }
  invoke("buzz_watch", { durationMs: CUE_BUZZ_MS }).catch(() => {
    session.buzzFailed = true;
  });
}

function tick() {
  const session = running;
  if (!session) return;
  const state = telemetryStore.getDatasetRecordingState();
  if (state === "arming") return publish();
  if (state !== "recording") return finish();
  if (session.startedAtMs === null) session.startedAtMs = performance.now();
  const elapsed = performance.now() - session.startedAtMs;
  const now = stepAt(session.steps, elapsed);
  if (now?.step.kind === "cue" && now.index !== session.lastCueIndex) {
    session.lastCueIndex = now.index;
    buzz(session);
  }
  const wanted = labelAt(session.steps, elapsed);
  if (wanted !== session.applied && telemetryStore.setTimelineLabel(wanted, "guided_cue")) session.applied = wanted;
  publish();
}

function finish() {
  if (!running) return;
  clearInterval(running.timer);
  running = null;
  publish();
}

/**
 * Runs a guided session over a timeline recording, outside any page, so switching tabs does not stop it. The recording
 * stops by itself when the plan ends (through the timed capture, which also saves and exports it, as for any timed
 * recording); stopping or discarding it by hand ends the session too.
 */
export const guidedRunner = {
  start(plan: GuidedPlan, random: () => number = Math.random): boolean {
    if (running || telemetryStore.getDatasetRecording()) return false;
    const steps = planSteps(plan, random);
    if (!telemetryStore.setDatasetCaptureMode("timeline")) return false;
    timedCapture.request(Math.ceil(totalMs(steps) / 1000));
    if (!telemetryStore.startDatasetRecording()) {
      timedCapture.take();
      return false;
    }
    running = { steps, startedAtMs: null, applied: null, lastCueIndex: -1, buzzFailed: false, timer: setInterval(tick, TICK_MS) };
    publish();
    return true;
  },
  /** Stops cueing; the recording itself is stopped or discarded by the recorder. */
  stop(): void {
    if (running?.applied) telemetryStore.setTimelineLabel(null);
    finish();
  },
  snapshot(): GuidedSnapshot | null {
    return snapshot;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
