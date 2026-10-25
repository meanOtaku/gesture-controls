/**
 * A guided session: the app says when to make the gesture (on screen, and with a buzz on the watch) and labels it at that
 * moment, so no key has to be held and every label starts the same way. Each label begins at the cue, so it trails the
 * gesture by your reaction time (about 0.3 s): a steady lag, which Label timing on the Labelling page measures and removes.
 *
 * A plan can also ask for stretches of everyday activity (typing, walking, …), labelled with an everyday label, so a model
 * learns what is not the gesture from the same session.
 */

/** One stretch of everyday activity in a plan. */
export interface GuidedActivity {
  activity: string;
  seconds: number;
}

export interface GuidedPlan {
  /** The gesture to cue. */
  label: string;
  /** How many times to cue it. */
  cues: number;
  /** How long to hold each one. */
  holdMs: number;
  /** The rest before each cue is picked at random between these, so the cues cannot be anticipated. */
  minGapSeconds: number;
  maxGapSeconds: number;
  /** The label for the everyday stretches; with none, they are recorded unlabelled. */
  everydayLabel: string | null;
  activities: GuidedActivity[];
}

export type GuidedStep =
  | { kind: "rest"; atMs: number; durationMs: number }
  | { kind: "cue"; atMs: number; durationMs: number; label: string; number: number; of: number }
  | { kind: "activity"; atMs: number; durationMs: number; label: string | null; activity: string };

/** A few seconds to settle before the first cue. */
export const LEAD_IN_MS = 5000;
/** The last seconds of a rest count down to the cue. */
export const COUNTDOWN_MS = 3000;
/** How long the watch buzzes at a cue. */
export const CUE_BUZZ_MS = 120;
/** A short pause between activities, to change what you are doing. */
const ACTIVITY_CHANGE_MS = 3000;

export const DEFAULT_PLAN: GuidedPlan = {
  label: "",
  cues: 20,
  holdMs: 800,
  minGapSeconds: 4,
  maxGapSeconds: 8,
  everydayLabel: null,
  activities: [
    { activity: "Type on the keyboard", seconds: 60 },
    { activity: "Use the mouse", seconds: 45 },
    { activity: "Move your arm around, reach and scratch", seconds: 45 },
  ],
};

/** What is wrong with a plan, or null when it can be run. */
export function planProblem(plan: GuidedPlan): string | null {
  if (plan.label.trim() === "") return "Choose the gesture to cue.";
  if (!Number.isInteger(plan.cues) || plan.cues < 1 || plan.cues > 500) return "Cue it 1 to 500 times.";
  if (!(plan.holdMs >= 100 && plan.holdMs <= 5000)) return "Hold each one 0.1 to 5 s.";
  if (!(plan.minGapSeconds >= 1 && plan.maxGapSeconds >= plan.minGapSeconds && plan.maxGapSeconds <= 60)) {
    return "Rest 1 to 60 s between cues, the shortest no longer than the longest.";
  }
  if (plan.activities.some((entry) => !(entry.seconds >= 5 && entry.seconds <= 900) || entry.activity.trim() === "")) {
    return "Give each everyday activity a name and 5 to 900 s.";
  }
  return null;
}

/** The session, step by step: a lead-in, the cues with random rests, then each everyday activity. */
export function planSteps(plan: GuidedPlan, random: () => number = Math.random): GuidedStep[] {
  const steps: GuidedStep[] = [];
  let at = 0;
  const push = (step: GuidedStep) => {
    steps.push(step);
    at += step.durationMs;
  };
  push({ kind: "rest", atMs: 0, durationMs: LEAD_IN_MS });
  for (let number = 1; number <= plan.cues; number += 1) {
    if (number > 1) {
      const gap = plan.minGapSeconds + random() * (plan.maxGapSeconds - plan.minGapSeconds);
      push({ kind: "rest", atMs: at, durationMs: Math.round(gap * 1000) });
    }
    push({ kind: "cue", atMs: at, durationMs: plan.holdMs, label: plan.label, number, of: plan.cues });
  }
  for (const entry of plan.activities) {
    push({ kind: "rest", atMs: at, durationMs: ACTIVITY_CHANGE_MS });
    push({ kind: "activity", atMs: at, durationMs: entry.seconds * 1000, label: plan.everydayLabel, activity: entry.activity });
  }
  // A little quiet at the end, so the last step is not cut by the stop.
  push({ kind: "rest", atMs: at, durationMs: 2000 });
  return steps;
}

export function totalMs(steps: GuidedStep[]): number {
  const last = steps.at(-1);
  return last ? last.atMs + last.durationMs : 0;
}

/** The step under way `elapsedMs` into the session, or null once it is over. */
export function stepAt(steps: GuidedStep[], elapsedMs: number): { step: GuidedStep; index: number; remainingMs: number } | null {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (elapsedMs < step.atMs + step.durationMs) return { step, index, remainingMs: step.atMs + step.durationMs - elapsedMs };
  }
  return null;
}

/** What to show for a step: the cue to act on, or what to do while waiting. */
export function prompt(steps: GuidedStep[], elapsedMs: number, nameOf: (label: string) => string = (label) => label): { title: string; detail: string; tone: "cue" | "ready" | "rest" | "activity" | "done" } {
  const now = stepAt(steps, elapsedMs);
  if (!now) return { title: "Done", detail: "The session is over and being saved.", tone: "done" };
  const { step, index, remainingMs } = now;
  if (step.kind === "cue") return { title: `${nameOf(step.label)} now`, detail: `Hold it… (${step.number} of ${step.of})`, tone: "cue" };
  if (step.kind === "activity") {
    return { title: step.activity, detail: `${Math.ceil(remainingMs / 1000)} s left. Do it naturally; no gesture.`, tone: "activity" };
  }
  const next = steps[index + 1];
  if (next?.kind === "cue" && remainingMs <= COUNTDOWN_MS) {
    return { title: `Get ready… ${Math.ceil(remainingMs / 1000)}`, detail: `Cue ${next.number} of ${next.of}`, tone: "ready" };
  }
  if (next?.kind === "activity") return { title: "Next:", detail: next.activity, tone: "rest" };
  return { title: "Relax", detail: "Hand still and open, as you would hold it normally.", tone: "rest" };
}

/** The label that should be on at `elapsedMs`: the cued gesture during a cue, the everyday label during an activity. */
export function labelAt(steps: GuidedStep[], elapsedMs: number): string | null {
  const step = stepAt(steps, elapsedMs)?.step;
  if (!step || step.kind === "rest") return null;
  return step.label;
}

const STORAGE_KEY = "recorder.guidedPlan";

export function loadPlan(): GuidedPlan {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<GuidedPlan> | null;
    if (stored && typeof stored === "object") return { ...DEFAULT_PLAN, ...stored, activities: Array.isArray(stored.activities) ? stored.activities : DEFAULT_PLAN.activities };
  } catch {
    // A missing or broken plan falls back to the default.
  }
  return DEFAULT_PLAN;
}

export function savePlan(plan: GuidedPlan): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
  } catch {
    // Remembering the plan is a convenience.
  }
}
