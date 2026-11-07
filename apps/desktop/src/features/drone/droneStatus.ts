import { invoke } from "@tauri-apps/api/core";

/** Mirrors `drone::DroneFlow`. */
export interface DroneFlow {
  frame: number;
  dx: number;
  dy: number;
  zoom: number;
  confidence: number;
}

/** Mirrors `drone::DroneState`. */
export interface DroneState {
  phase: "disconnected" | "opening" | "open" | "failed" | "closed";
  armed: boolean;
  failsafeTripped: boolean;
  steering: boolean;
  watchStreaming: boolean;
  framesSent: number;
  videoFrames: number;
  videoSkipped: number;
  videoDamaged: number;
  sendErrors: number;
  flow: DroneFlow | null;
  driftX: number;
  driftY: number;
  holding: boolean;
  holdPhase: "off" | "calibrating" | "holding" | "failed";
  holdFault: string | null;
  correction: { aileron: number; elevator: number } | null;
  heightRate: number;
  flightLog: string | null;
  pageAlive: boolean;
  onNetwork: boolean;
  firmware: string | null;
}

/** The drone's state, and the video frames arriving each second, or null until a second has passed. */
export interface DroneStatus extends DroneState {
  videoRate: number | null;
}

export type DroneTone = "active" | "offline" | "unknown" | "caution";

const POLL_MS = 500;
const RATE_WINDOW_MS = 1000;

let snapshot: DroneStatus | null = null;
let rateFrom: { at: number; frames: number } | null = null;
let timer: number | null = null;
const listeners = new Set<() => void>();

/** Takes in a reading, working out the frame rate from how the total moves. */
export function publishDroneState(state: DroneState | null, now = Date.now()) {
  if (!state) {
    snapshot = null;
    rateFrom = null;
  } else {
    let videoRate = snapshot?.videoRate ?? null;
    if (!rateFrom || state.videoFrames < rateFrom.frames) {
      rateFrom = { at: now, frames: state.videoFrames };
      videoRate = null;
    } else if (now - rateFrom.at >= RATE_WINDOW_MS) {
      videoRate = Math.round(((state.videoFrames - rateFrom.frames) * 1000) / (now - rateFrom.at));
      rateFrom = { at: now, frames: state.videoFrames };
    }
    snapshot = { ...state, videoRate };
  }
  for (const listener of listeners) listener();
}

function poll() {
  void Promise.resolve(invoke<DroneState>("get_drone_state"))
    .then((state) => { publishDroneState(state ?? null); })
    .catch(() => { publishDroneState(null); });
}

/** Polls only while something is showing the drone, and only in the desktop app. */
export function subscribeDrone(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null && "__TAURI_INTERNALS__" in window) {
    poll();
    timer = window.setInterval(poll, POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export const getDroneSnapshot = () => snapshot;

/** The version in a firmware name such as `(NOFLOW)FLOW_720P_V1.4.17_20250520`, short enough for a small panel. */
export function firmwareVersion(firmware: string | null): string | null {
  return firmware?.match(/V\d+(?:\.\d+)+/)?.[0] ?? firmware;
}

/** The drone as a device, the way the top and bottom bars show one. */
export function droneDevice(status: DroneStatus | null): { tone: DroneTone; text: string } {
  if (!status) return { tone: "offline", text: "OFFLINE" };
  if (status.failsafeTripped) return { tone: "caution", text: "FAILSAFE" };
  switch (status.phase) {
    case "opening": return { tone: "unknown", text: "CONNECTING" };
    case "failed": return { tone: "caution", text: "NO ANSWER" };
    case "open":
      if (status.holdPhase === "calibrating") return { tone: "caution", text: "CALIBRATING" };
      if (status.holding) return { tone: "caution", text: "HOLDING" };
      return status.armed ? { tone: "caution", text: "ARMED" } : { tone: "active", text: "ONLINE" };
    default: return { tone: "offline", text: "OFFLINE" };
  }
}
