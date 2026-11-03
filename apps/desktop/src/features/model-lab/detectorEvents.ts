/**
 * The desktop's replays counted as `docs/research/gesture-detector-evaluation-metrics.md` counts them
 * (`detector_events.rs`): each detection a catch, a repeat, late, or a false activation; false activations per hour with no
 * gesture under way; camera-timed and estimated recordings apart.
 */

/** Mirrors `detector_events::EventTotals`. */
export interface EventTotals {
  recordings: number;
  starts: number;
  caught: number;
  /** Fired again during a gesture it had caught. */
  repeats: number;
  /** Fired during a gesture it had not caught in time (that gesture counts as missed). */
  late: number;
  /** Fired with no gesture under way. */
  falseActivations: number;
  negativeSeconds: number;
  falseActivationsPerHour: number | null;
}

/** "noGesture": everyday noise, with no gesture to time; judged with the camera-timed recordings. */
export type LabelTiming = "camera" | "estimated" | "unknown" | "noGesture";

/** Mirrors `detector_events::Judged`. */
export interface Judged extends EventTotals {
  /** "camera": judged on the camera-timed recordings (and any of no gesture) only, as there were others too and enough. */
  cohort: "camera" | "all";
  byLabelTiming: Partial<Record<LabelTiming, EventTotals>>;
}

/** The release gate's budget (`FALSE_ACTIVATIONS_BUDGET_PER_HOUR`), per hour with no gesture under way. */
export const FALSE_ACTIVATIONS_BUDGET_PER_HOUR = 30;

export const TIMING_NAME: Record<LabelTiming, string> = {
  camera: "camera-timed",
  estimated: "estimated from motion",
  unknown: "timing not known",
  noGesture: "no gesture (everyday noise)",
};

const share = (part: number, whole: number) => (whole > 0 ? ` (${Math.round((part / whole) * 100)}%)` : "");

/** False activations an hour with no gesture under way, rounded; "–" when there was no such time. */
export const perHour = (totals: EventTotals) => (totals.falseActivationsPerHour === null ? "–" : `${Math.round(totals.falseActivationsPerHour)}`);

/** Whether the false activations stay within the budget (with no time to measure them in, only when there were none). */
export const withinBudget = (totals: EventTotals, budget = FALSE_ACTIVATIONS_BUDGET_PER_HOUR) =>
  totals.falseActivationsPerHour === null ? totals.falseActivations === 0 : totals.falseActivationsPerHour <= budget;

/** "1 repeat and 2 late", or "" when there were neither. */
export function duringGestures(totals: EventTotals): string {
  return [
    totals.repeats > 0 ? `${totals.repeats} repeat${totals.repeats === 1 ? "" : "s"}` : "",
    totals.late > 0 ? `${totals.late} late` : "",
  ].filter(Boolean).join(" and ");
}

/** The totals in words: "caught 10 of 25 starts (40%), 18 false activations an hour with no gesture under way; 1 repeat". */
export function describeTotals(totals: EventTotals): string {
  const during = duringGestures(totals);
  return `caught ${totals.caught} of ${totals.starts} starts${share(totals.caught, totals.starts)}, ${perHour(totals)} false activations an hour with no gesture under way${during ? `; ${during}` : ""}`;
}

/**
 * Which recordings a judged total covers, how the other kinds of label timing did, and how often it fired on everyday
 * noise; null when every recording was timed one way and none is noise.
 */
export function cohortNote(judged: Judged): string | null {
  const timings = (Object.keys(judged.byLabelTiming) as LabelTiming[]).filter((timing) => judged.byLabelTiming[timing]);
  const noise = judged.byLabelTiming.noGesture;
  const notes: string[] = [];
  if (timings.filter((timing) => timing !== "noGesture").length >= 2) {
    const trusted = (timing: LabelTiming) => timing === "camera" || timing === "noGesture";
    const others = timings
      .filter((timing) => timing !== "noGesture" && (judged.cohort !== "camera" || !trusted(timing)))
      .map((timing) => `${TIMING_NAME[timing]} (${judged.byLabelTiming[timing]!.recordings}): ${describeTotals(judged.byLabelTiming[timing]!)}`);
    notes.push(judged.cohort === "camera"
      ? `Judged on the ${judged.byLabelTiming.camera!.recordings} camera-timed recordings${noise ? ` and the ${noise.recordings} of everyday noise` : ""}. Shown, not judged on: ${others.join("; ")}.`
      : `Too few camera-timed pinches to judge on them alone, so all recordings together. Apart: ${others.join("; ")}.`);
  }
  if (noise) {
    notes.push(`On everyday noise (${noise.recordings} recording${noise.recordings === 1 ? "" : "s"}, ${Math.round(noise.negativeSeconds / 60)} min): ${perHour(noise)} false activations an hour, what daily use would see.`);
  }
  return notes.length > 0 ? notes.join(" ") : null;
}
