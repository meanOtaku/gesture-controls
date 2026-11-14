import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/**
 * Whether the running models can catch a gesture right now (`label_inference::readiness`). After the wrist moves, a pinch
 * is caught as reliably as on a still hand once it has been calm for about a second (measured in
 * `docs/research/artifacts/readiness-2026-11/`); after a stream drops, a CNN has nothing to score for up to 11 s.
 */
export const LABEL_READINESS_EVENT = "label-readiness";
/** How often the light asks for the readiness as well as listening for it. */
const RECHECK_MS = 1_000;

export type ReadinessState = "ready" | "moving" | "settling" | "waiting" | "stale" | "warmingUp" | "gap" | "offWrist";

/** Mirrors `ReadinessView` in `label_runtime.rs`. */
export interface ReadinessView {
  label: string;
  state: ReadinessState;
  /** How long until ready, when that is known. */
  readyInMs: number | null;
}

/** The less ready, the higher: the light shows the least ready model. */
const SEVERITY: Record<ReadinessState, number> = {
  ready: 0, settling: 1, moving: 2, warmingUp: 3, gap: 4, stale: 5, waiting: 5, offWrist: 6,
};

export interface Readiness {
  state: ReadinessState;
  /** When it will be ready (ms since the epoch), when known. */
  readyAt: number | null;
}

/** The models' readiness as one: the least ready model's state, ready when the last countdown ends. Null with no models. */
export function overall(views: readonly ReadinessView[], receivedAt: number): Readiness | null {
  if (views.length === 0) return null;
  const worst = views.reduce((a, b) => (SEVERITY[b.state] > SEVERITY[a.state] ? b : a));
  const waits = views.filter((v) => v.state !== "ready" && v.readyInMs !== null).map((v) => receivedAt + (v.readyInMs ?? 0));
  return { state: worst.state, readyAt: worst.state === "ready" || waits.length === 0 ? null : Math.max(...waits) };
}

export type Tone = "ok" | "wait" | "off";

/** What the light says: its words, how it looks, and whether a countdown goes with it. */
export function describe(state: ReadinessState): { title: string; tone: Tone; countdown: string | null } {
  switch (state) {
    case "ready": return { title: "Ready to pinch", tone: "ok", countdown: null };
    case "settling": return { title: "Hold still", tone: "wait", countdown: "" };
    case "moving": return { title: "Wrist moving", tone: "wait", countdown: null };
    case "warmingUp": return { title: "Starting up", tone: "wait", countdown: "" };
    case "gap": return { title: "Signal dropped", tone: "off", countdown: "back in " };
    case "stale": return { title: "No signal from the watch", tone: "off", countdown: null };
    case "waiting": return { title: "Waiting for the watch", tone: "off", countdown: null };
    case "offWrist": return { title: "Watch off the wrist", tone: "off", countdown: null };
  }
}

/** Seconds left to show: tenths under 2 s (a wait you hold still through), whole seconds above. */
export function secondsLeft(readyAt: number, now: number): { value: number; digits: number } {
  const seconds = Math.max(0, (readyAt - now) / 1000);
  return seconds < 2 ? { value: Math.ceil(seconds * 10) / 10, digits: 1 } : { value: Math.ceil(seconds), digits: 0 };
}

/** The running models' readiness, live, and the time now (updated while a countdown runs). Null while none run. */
export function useModelReadiness(): { readiness: Readiness | null; now: number } {
  const [views, setViews] = useState<{ list: ReadinessView[]; at: number }>({ list: [], at: Date.now() });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    // Anything but a list (an older desktop without the command) is no models running.
    const take = (list: unknown) => { if (!disposed) setViews({ list: Array.isArray(list) ? list : [], at: Date.now() }); };
    const ask = () => void invoke<ReadinessView[]>("get_label_readiness").then(take).catch(() => undefined);
    ask();
    const registration = listen<ReadinessView[]>(LABEL_READINESS_EVENT, ({ payload }) => take(payload));
    // The event says every change, but one missed (a page that was busy, a listener not yet registered) would leave the
    // light saying "ready" with no watch at all; asking again now and then puts it right within a second.
    const recheck = window.setInterval(ask, RECHECK_MS);
    return () => {
      disposed = true;
      window.clearInterval(recheck);
      void registration.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, []);
  const readiness = overall(views.list, views.at);
  const counting = readiness?.readyAt != null;
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [counting]);
  return { readiness, now };
}
