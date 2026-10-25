import { negativeSpanFor, NO_LABEL, type Span } from "./labellingModel";

/**
 * Stretches worth a look that nobody has labelled yet: where the camera saw the fingers close, where a model fired with
 * no gesture labelled, and where the wrist moved sharply. Each comes with the label it most likely needs (or none, when
 * only you can tell), so reviewing them is a matter of accepting, changing or skipping each in turn.
 */
export interface Suggestion {
  startMs: number;
  endMs: number;
  /** The label it probably needs; null when it could be anything. */
  label: string | null;
  source: "camera" | "model" | "motion";
  reason: string;
}

/** Stretches where the fingers were closed: from each fall below `threshold` to the next rise back to it (at most 3 s). */
export function contactSpans(track: { timesMs: number[]; values: (number | null)[] }, threshold: number): { startMs: number; endMs: number }[] {
  const spans: { startMs: number; endMs: number }[] = [];
  let open = false;
  let closedAt: number | null = null;
  track.values.forEach((value, i) => {
    if (value === null) return;
    const at = track.timesMs[i];
    if (closedAt !== null && (value >= threshold || at - closedAt > MAX_CONTACT_MS)) {
      spans.push({ startMs: closedAt, endMs: Math.min(at, closedAt + MAX_CONTACT_MS) });
      closedAt = null;
    }
    if (value >= threshold) open = true;
    else if (open && closedAt === null) {
      closedAt = at;
      open = false;
    }
  });
  return spans;
}
const MAX_CONTACT_MS = 3000;

/** A sharp move stands this many deviations above the recording's usual rotation speed. */
const BURST_DEVIATIONS = 6;
/** And at least this fast (rad/s), so a still recording does not find bursts in its noise. */
const BURST_FLOOR = 0.6;
const BURST_JOIN_MS = 300;
const BURST_MIN_MS = 100;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Stretches where the wrist turned sharply, from the gyroscope: well above its usual speed in this recording. */
export function motionBursts(timesMs: number[], gyro: [(number | null)[], (number | null)[], (number | null)[]]): { startMs: number; endMs: number }[] {
  const speed: { at: number; value: number }[] = [];
  timesMs.forEach((at, i) => {
    const [x, y, z] = [gyro[0][i], gyro[1][i], gyro[2][i]];
    if (x === null || y === null || z === null) return;
    speed.push({ at, value: Math.hypot(x, y, z) });
  });
  const values = speed.map((entry) => entry.value);
  const middle = median(values);
  const spread = median(values.map((value) => Math.abs(value - middle))) * 1.4826;
  const limit = Math.max(BURST_FLOOR, middle + BURST_DEVIATIONS * spread);
  const bursts: { startMs: number; endMs: number }[] = [];
  for (const { at, value } of speed) {
    if (value < limit) continue;
    const last = bursts.at(-1);
    if (last && at - last.endMs <= BURST_JOIN_MS) last.endMs = at;
    else bursts.push({ startMs: at, endMs: at });
  }
  return bursts
    .filter((burst) => burst.endMs - burst.startMs >= BURST_MIN_MS)
    .map((burst) => ({ startMs: Math.max(0, burst.startMs - 100), endMs: burst.endMs + 100 }));
}

const overlaps = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) => a.startMs < b.endMs && b.startMs < a.endMs;

/**
 * The suggestions for a recording, in time order, leaving out any that touch a stretch already labelled (by the recorder
 * or by hand, "Nothing here" included: that is a decision too) and any you skipped.
 */
export function suggestionsFor(input: {
  contacts: { startMs: number; endMs: number }[];
  /** The contact's likely label (the pinch the camera's threshold comes from). */
  contactLabel: string | null;
  falseDetections: { startMs: number; label: string }[];
  everydayLabel: string | null;
  bursts: { startMs: number; endMs: number }[];
  recorded: Span[];
  byHand: Span[];
  skipped: Set<string>;
}): Suggestion[] {
  const labelled = [...input.recorded.filter((span) => span.label !== NO_LABEL), ...input.byHand];
  const all: Suggestion[] = [
    ...input.contacts.map((span) => ({ ...span, label: input.contactLabel, source: "camera" as const, reason: "The camera saw the fingers close here" })),
    ...input.falseDetections.map((detection) => ({
      ...negativeSpanFor(detection.startMs),
      label: input.everydayLabel,
      source: "model" as const,
      reason: `The ${detection.label} model fired here, with no ${detection.label} labelled`,
    })),
    ...input.bursts.map((span) => ({ ...span, label: null, source: "motion" as const, reason: "The wrist turned sharply here" })),
  ];
  const kept: Suggestion[] = [];
  for (const suggestion of all.sort((a, b) => a.startMs - b.startMs)) {
    if (input.skipped.has(suggestionKey(suggestion))) continue;
    if (labelled.some((span) => overlaps(span, suggestion))) continue;
    // Where two sources point at the same moment, the surer one says it: the camera, then a model, then motion.
    const clash = kept.findIndex((other) => overlaps(other, suggestion));
    if (clash < 0) kept.push(suggestion);
    else if (SURENESS[suggestion.source] > SURENESS[kept[clash].source]) kept[clash] = suggestion;
  }
  return kept;
}

const SURENESS: Record<Suggestion["source"], number> = { camera: 3, model: 2, motion: 1 };

export const suggestionKey = (suggestion: Pick<Suggestion, "source" | "startMs">) => `${suggestion.source}:${Math.round(suggestion.startMs)}`;
