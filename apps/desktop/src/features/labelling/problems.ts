import { caughtStarts, LEFT_OUT, NO_LABEL, paint, PAIRING_WINDOW_MS, type Span } from "./labellingModel";

/** A place where the labels, the camera and a model disagree: worth a look. */
export interface Problem {
  atMs: number;
  text: string;
}

/** Training ignores a hold shorter than this (`dataset_files::MIN_HOLD_MS`). */
const MIN_HOLD_MS = 200;
/** A contact this close to a gesture's label is the same gesture. */
const CONTACT_NEAR_MS = 500;

/** The labels each row trains on: the recorded ones, with yours over them ("Nothing here" clears them). */
export function effectiveSpans(recorded: Span[], byHand: Span[]): Span[] {
  let spans = recorded.filter((span) => span.label !== NO_LABEL);
  for (const span of byHand) spans = paint(spans, span.startMs, span.endMs, span.label);
  return spans.filter((span) => span.label !== NO_LABEL);
}

/**
 * Every place worth a second look, in time order: a hold too short to train on, a gesture labelled where the camera saw
 * no contact, a contact with nothing labelled, a model firing with nothing labelled, and a labelled gesture a model missed.
 */
export function problemsIn(input: {
  recorded: Span[];
  byHand: Span[];
  /** Where the fingers were closed; null with no camera. */
  contacts: { startMs: number; endMs: number }[] | null;
  /** Labels that are gestures (the camera's contacts are about them). */
  gestures: Set<string>;
  models: { label: string; detections: Span[] }[];
  nameOf: (label: string) => string;
}): Problem[] {
  const spans = effectiveSpans(input.recorded, input.byHand);
  const found: Problem[] = [];
  for (const span of spans) {
    if (span.label !== LEFT_OUT && span.endMs - span.startMs < MIN_HOLD_MS) found.push({ atMs: span.startMs, text: `${input.nameOf(span.label)} lasts ${Math.round(span.endMs - span.startMs)} ms: too short to train on` });
  }
  if (input.contacts) {
    for (const span of spans) {
      if (!input.gestures.has(span.label)) continue;
      if (!input.contacts.some((contact) => Math.abs(contact.startMs - span.startMs) <= PAIRING_WINDOW_MS)) {
        found.push({ atMs: span.startMs, text: `${input.nameOf(span.label)} is labelled, but the camera saw no contact near it` });
      }
    }
    for (const contact of input.contacts) {
      const near = spans.some((span) => (input.gestures.has(span.label) || span.label === LEFT_OUT) && span.startMs - CONTACT_NEAR_MS <= contact.endMs && contact.startMs <= span.endMs + CONTACT_NEAR_MS);
      if (!near) found.push({ atMs: contact.startMs, text: "The camera saw the fingers close, with no gesture labelled" });
    }
  }
  for (const model of input.models) {
    const starts = spans.filter((span) => span.label === model.label).map((span) => span.startMs);
    caughtStarts(model.detections, starts).forEach((caught, i) => {
      if (!caught) found.push({ atMs: model.detections[i].startMs, text: `The ${input.nameOf(model.label)} model fired with no ${input.nameOf(model.label)} starting 0.68 to 1.28 s before` });
    });
    for (const start of starts) {
      if (!caughtStarts(model.detections, [start]).some(Boolean)) found.push({ atMs: start, text: `The ${input.nameOf(model.label)} model missed this ${input.nameOf(model.label)}` });
    }
  }
  return found.sort((a, b) => a.atMs - b.atMs);
}

/** The first problem after `atMs` (by more than a moment), or before it, going `direction`; null when there is none. */
export function nextProblem(problems: Problem[], atMs: number, direction: 1 | -1): Problem | null {
  const MOMENT = 50;
  if (direction === 1) return problems.find((problem) => problem.atMs > atMs + MOMENT) ?? null;
  return [...problems].reverse().find((problem) => problem.atMs < atMs - MOMENT) ?? null;
}
