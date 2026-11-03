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

export type LabelTiming = "camera" | "estimated" | "unknown";

/** Mirrors `detector_events::Judged`. */
export interface Judged extends EventTotals {
  /** "camera": judged on the camera-timed recordings only, as there were others too and enough of them. */
  cohort: "camera" | "all";
  byLabelTiming: Partial<Record<LabelTiming, EventTotals>>;
}

/** The release gate's budget (`FALSE_ACTIVATIONS_BUDGET_PER_HOUR`), per hour with no gesture under way. */
export const FALSE_ACTIVATIONS_BUDGET_PER_HOUR = 30;

export const TIMING_NAME: Record<LabelTiming, string> = {
  camera: "camera-timed",
  estimated: "estimated from motion",
  unknown: "timing not known",
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
 * Which recordings a judged total covers, and how the other kinds of label timing did, or null when every recording was
 * timed one way.
 */
export function cohortNote(judged: Judged): string | null {
  const timings = (Object.keys(judged.byLabelTiming) as LabelTiming[]).filter((timing) => judged.byLabelTiming[timing]);
  if (timings.length < 2) return null;
  const others = timings
    .filter((timing) => judged.cohort !== "camera" || timing !== "camera")
    .map((timing) => `${TIMING_NAME[timing]} (${judged.byLabelTiming[timing]!.recordings}): ${describeTotals(judged.byLabelTiming[timing]!)}`);
  return judged.cohort === "camera"
    ? `Judged on the ${judged.byLabelTiming.camera!.recordings} camera-timed recordings. Shown, not judged on: ${others.join("; ")}.`
    : `Too few camera-timed pinches to judge on them alone, so all recordings together. Apart: ${others.join("; ")}.`;
}
