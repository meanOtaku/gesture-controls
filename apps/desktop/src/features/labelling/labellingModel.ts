/**
 * The Labelling page's pure logic: the hand labels as spans of time, painting and erasing them, undo and redo, and how
 * much of a long recording each pixel of a graph stands for. No React and no desktop calls, so it is tested on its own.
 */

/** A labelled span, in milliseconds after the recording's first sample. `label` is a label id or `NO_LABEL`. */
export interface Span {
  startMs: number;
  endMs: number;
  label: string;
}

/** A hand label saying "nothing here": the rows are unlabelled whatever the recorder or camera said. */
export const NO_LABEL = "-";
/** The label of a stretch left out (strap loose, poor contact): kept in the recording, never trained on (`dataset_files::LEFT_OUT_LABEL`). */
export const LEFT_OUT = "left_out";

/** Where a painted span's neighbour now ends or starts, just short of it, so no row belongs to both. */
const EDGE_MS = 1e-6;

/**
 * The hand labels after painting `label` over `startMs`–`endMs`, or after erasing that stretch when `label` is null. The
 * spans stay sorted and never overlap: whatever was there is cut back around the new span, and a neighbour with the same
 * label that touches it is joined to it.
 */
export function paint(spans: Span[], startMs: number, endMs: number, label: string | null): Span[] {
  const [start, end] = startMs <= endMs ? [startMs, endMs] : [endMs, startMs];
  const out: Span[] = [];
  for (const span of spans) {
    if (span.endMs < start || span.startMs > end) {
      out.push(span);
      continue;
    }
    if (span.startMs < start) out.push({ ...span, endMs: start - EDGE_MS });
    if (span.endMs > end) out.push({ ...span, startMs: end + EDGE_MS });
  }
  if (label !== null) out.push({ startMs: start, endMs: end, label });
  out.sort((a, b) => a.startMs - b.startMs);
  const joined: Span[] = [];
  for (const span of out) {
    const last = joined[joined.length - 1];
    if (last && last.label === span.label && span.startMs - last.endMs <= EDGE_MS * 2) {
      joined[joined.length - 1] = { ...last, endMs: Math.max(last.endMs, span.endMs) };
    } else {
      joined.push(span);
    }
  }
  return joined;
}

/** The span covering `atMs`, if any. */
export function spanAt(spans: Span[], atMs: number): Span | null {
  return spans.find((span) => span.startMs <= atMs && atMs <= span.endMs) ?? null;
}

/** An edit history: the hand labels now, and what undo and redo would bring back. */
export interface History {
  past: Span[][];
  present: Span[];
  future: Span[][];
}

const HISTORY_LIMIT = 200;

export function historyOf(spans: Span[]): History {
  return { past: [], present: spans, future: [] };
}

export function commit(history: History, next: Span[]): History {
  if (sameSpans(history.present, next)) return history;
  return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo(history: History): History {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

export function sameSpans(a: Span[], b: Span[]): boolean {
  return a.length === b.length && a.every((span, i) => span.startMs === b[i].startMs && span.endMs === b[i].endMs && span.label === b[i].label);
}

/** The first index of `times` (sorted) at or after `atMs`. */
export function lowerBound(times: ArrayLike<number>, atMs: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < atMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The rows to draw for a view: those inside it, plus the one just before and the one just after, so a line reaches both
 * edges even when the view falls between two samples. `[first, last]` inclusive; empty (first > last) with no rows.
 */
export function rowsToDraw(times: ArrayLike<number>, fromMs: number, toMs: number): [number, number] {
  if (times.length === 0) return [0, -1];
  const first = Math.max(0, lowerBound(times, fromMs) - 1);
  const last = Math.min(times.length - 1, lowerBound(times, toMs));
  return [first, last];
}

/** The lowest and highest value of each of `buckets` equal stretches of `fromMs`–`toMs`; null where a stretch has none. */
export function minMaxBuckets(
  times: ArrayLike<number>,
  values: ArrayLike<number | null>,
  fromMs: number,
  toMs: number,
  buckets: number,
): ({ min: number; max: number } | null)[] {
  const out: ({ min: number; max: number } | null)[] = new Array(buckets).fill(null);
  if (buckets <= 0 || toMs <= fromMs) return out;
  const width = (toMs - fromMs) / buckets;
  for (let i = lowerBound(times, fromMs); i < times.length && times[i] <= toMs; i += 1) {
    const value = values[i];
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    const bucket = Math.min(buckets - 1, Math.floor((times[i] - fromMs) / width));
    const current = out[bucket];
    if (current === null) out[bucket] = { min: value, max: value };
    else {
      if (value < current.min) current.min = value;
      if (value > current.max) current.max = value;
    }
  }
  return out;
}

/** The view after zooming by `factor` (under 1 zooms in) around `atMs`, kept inside the recording and never under 50 ms. */
export function zoom(view: { startMs: number; endMs: number }, atMs: number, factor: number, durationMs: number) {
  const width = Math.min(durationMs, Math.max(50, (view.endMs - view.startMs) * factor));
  const share = (atMs - view.startMs) / Math.max(1e-9, view.endMs - view.startMs);
  return clampView(atMs - share * width, width, durationMs);
}

/** The view moved by `deltaMs`, kept inside the recording. */
export function pan(view: { startMs: number; endMs: number }, deltaMs: number, durationMs: number) {
  return clampView(view.startMs + deltaMs, view.endMs - view.startMs, durationMs);
}

function clampView(startMs: number, width: number, durationMs: number) {
  const start = Math.min(Math.max(0, startMs), Math.max(0, durationMs - width));
  return { startMs: start, endMs: start + width };
}

/** "12.345 s": a time on the recording, to the millisecond. */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(3)} s`;
}

/** A detection 680 to 1,280 ms after a start of its gesture catches it, as the trainer and the research count them. */
export const CATCH_FROM_MS = 680;
export const CATCH_TO_MS = 1280;
/** Training takes a moment 880 ms after each labelled start; a span starting this long before a false detection puts it there. */
export const DECISION_DELAY_MS = 880;

/** Whether each detection caught a start of its gesture (one of `startsMs`), in order. */
export function caughtStarts(detections: Span[], startsMs: number[]): boolean[] {
  return detections.map((detection) => startsMs.some((start) => detection.startMs - start >= CATCH_FROM_MS && detection.startMs - start <= CATCH_TO_MS));
}

/**
 * The stretch to label as everyday activity so a false detection at `detectionMs` becomes a training example: training
 * takes a moment 880 ms after each labelled start of another label as a negative, so the span starts 880 ms before the
 * detection, and lasts long enough (1 s) to count as a hold.
 */
export function negativeSpanFor(detectionMs: number): { startMs: number; endMs: number } {
  return { startMs: Math.max(0, detectionMs - DECISION_DELAY_MS), endMs: detectionMs + 120 };
}

/** How far apart a label start and a camera contact may be to be taken as the same gesture. */
export const PAIRING_WINDOW_MS = 1500;

/**
 * How late the labels start against where the fingers touched: the median of (label start − nearest camera contact within
 * `PAIRING_WINDOW_MS`), positive when the labels are late. Null with fewer than three pairs.
 */
export function lagFromContacts(startsMs: number[], contactsMs: number[]): { lagMs: number; pairs: number } | null {
  const offsets: number[] = [];
  for (const start of startsMs) {
    let best: number | null = null;
    for (const contact of contactsMs) {
      const offset = start - contact;
      if (Math.abs(offset) <= PAIRING_WINDOW_MS && (best === null || Math.abs(offset) < Math.abs(best))) best = offset;
    }
    if (best !== null) offsets.push(best);
  }
  if (offsets.length < 3) return null;
  offsets.sort((a, b) => a - b);
  const mid = offsets.length >> 1;
  return { lagMs: offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2, pairs: offsets.length };
}

/**
 * How late the labels start as the model sees them: of label shifts from −1,500 to +1,000 ms in 50 ms steps, the one under
 * which the model's detections catch the most starts (ties: the smallest shift), returned as the lag (the shift reversed:
 * positive when the labels are late). Null when no shift catches any.
 */
export function lagFromDetections(startsMs: number[], detections: Span[]): { lagMs: number; caught: number; caughtAsIs: number } | null {
  const countAt = (shift: number) => caughtStarts(detections, startsMs.map((start) => start + shift)).filter(Boolean).length;
  let best = { shift: 0, caught: countAt(0) };
  for (let shift = -1500; shift <= 1000; shift += 50) {
    const caught = countAt(shift);
    if (caught > best.caught || (caught === best.caught && Math.abs(shift) < Math.abs(best.shift))) best = { shift, caught };
  }
  return best.caught === 0 ? null : { lagMs: -best.shift, caught: best.caught, caughtAsIs: countAt(0) };
}

/**
 * The hand labels after moving every recorded span `lagMs` earlier (later when negative): where each span was is marked
 * "nothing here", and the span is painted where it now goes, so the recording trains on the moved labels.
 */
export function shiftRecordedLabels(handLabels: Span[], recorded: Span[], lagMs: number): Span[] {
  let next = handLabels;
  for (const span of recorded) next = paint(next, span.startMs, span.endMs, NO_LABEL);
  for (const span of recorded) next = paint(next, Math.max(0, span.startMs - lagMs), Math.max(0, span.endMs - lagMs), span.label);
  return next;
}

/** `atMs`, moved to the nearest of `points` (sorted) if one is within `toleranceMs`. */
export function snapTo(atMs: number, points: number[], toleranceMs: number): number {
  const after = lowerBound(points, atMs);
  let best = atMs;
  let distance = toleranceMs;
  for (const i of [after - 1, after]) {
    if (i < 0 || i >= points.length) continue;
    const gap = Math.abs(points[i] - atMs);
    if (gap <= distance) {
      best = points[i];
      distance = gap;
    }
  }
  return best;
}
