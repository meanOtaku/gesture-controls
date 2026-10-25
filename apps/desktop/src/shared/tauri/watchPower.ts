import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Mirrors `watch_power::SensorRate`. */
export interface SensorRate {
  id: string;
  name: string;
  registered: boolean;
  requestedHz: number | null;
  achievedHz: number;
  fifoMaxEvents: number;
}

/** Mirrors `watch_power::PowerRates`. */
export interface PowerRates {
  seconds: number;
  batteryPercentPerHour: number | null;
  averageDrawMa: number | null;
  cpuPercent: number | null;
  sensorDeliveriesPerSecond: number;
  sensors: SensorRate[];
  ppgHz: number;
  ppgDeliveriesPerSecond: number;
  messagesPerSecond: number;
  bytesPerSecond: number;
  droppedMessages: number;
  refusedSends: number;
  charging: boolean;
  temperatureC: number | null;
}

/** Mirrors `watch_power::WatchPowerView`. */
export interface WatchPowerView {
  live: PowerRates | null;
  reporting: boolean;
  run: { label: string; startedAt: string; rates: PowerRates | null } | null;
}

/** Mirrors `watch_power::WatchMeasurement`. */
export interface WatchMeasurement {
  id: string;
  label: string;
  startedAt: string;
  endedAt: string;
  rates: PowerRates | null;
  delayP50Ms: number | null;
  delayP95Ms: number | null;
  notes: string[];
}

export const WATCH_POWER_EVENT = "watch-power";
const EMPTY: WatchPowerView = { live: null, reporting: false, run: null };

let latest: WatchPowerView = EMPTY;
let started = false;
const listeners = new Set<() => void>();

function publish(view: WatchPowerView) {
  latest = view;
  listeners.forEach((listener) => listener());
}

/** The watch's latest power figures, kept for the whole app: read by the Watch page and stored with each recording. */
export const watchPower = {
  /** Starts listening, once; the desktop publishes a view with each report from the watch. */
  start(): void {
    if (started || !("__TAURI_INTERNALS__" in window)) return;
    started = true;
    void listen<WatchPowerView>(WATCH_POWER_EVENT, ({ payload }) => publish(payload)).catch(() => undefined);
    void invoke<WatchPowerView>("get_watch_power").then(publish).catch(() => undefined);
  },
  get(): WatchPowerView {
    return latest;
  },
  set(view: WatchPowerView): void {
    publish(view);
  },
  subscribe(listener: () => void): () => void {
    watchPower.start();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** For tests. */
  reset(): void {
    latest = EMPTY;
    started = false;
  },
};
