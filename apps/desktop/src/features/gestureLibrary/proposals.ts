import type { SyncPair } from "../camera/clockSync";
import type { HandFrame } from "../camera/handTypes";
import type { AnnotationInterval } from "../../shared/tauri/recordingBundle";
import type { GestureDefinition } from "./definition";
import { CombinedGestureDetector, type CameraSlot } from "./combinedDetector";

/** How the camera's clock lines up with the watch's, from the pairs saved with a recording. */
export interface ClockAlignment {
  /** Add to a watch time in milliseconds to get the camera's clock. */
  offsetMs: number;
  /** About how far apart the two can be in time, from how jittery the link was. A proposal is never more exact than this. */
  jitterMs: number;
  samples: number;
}

/** The smallest arrival delay is the best estimate of the offset (see `clockSync.ts`); the 90th-percentile excess is the jitter. */
export function alignClocks(pairs: SyncPair[]): ClockAlignment | null {
  if (pairs.length < 5) return null;
  const delays = pairs.map((pair) => pair.browserArrivalMs - pair.watchTimestampNs / 1e6).sort((a, b) => a - b);
  const offsetMs = delays[0];
  return { offsetMs, jitterMs: delays[Math.min(delays.length - 1, Math.floor(delays.length * 0.9))] - offsetMs, samples: pairs.length };
}

export interface ProposedInterval {
  gestureId: string;
  gestureName: string;
  labelId: string;
  /** Camera clock, milliseconds. */
  startMs: number;
  endMs: number;
  /** Raw rows it covers, inclusive. */
  startRow: number;
  endRow: number;
  startNs: number;
  endNs: number;
  /** Set when it would overlap an interval already in the recording or an earlier proposal; such a proposal cannot be added. */
  overlaps: boolean;
}

/** First index with `values[i] >= target` (values ascending). */
function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface ProposeInput {
  definitions: GestureDefinition[];
  /** The first camera's frames. */
  frames: HandFrame[];
  /** The second camera's frames, when the recording used two. */
  secondFrames?: HandFrame[];
  alignment: ClockAlignment;
  /** The watch timestamp of every raw row, ascending. */
  rawTimestampsNs: number[];
  /** Raw rows (inclusive) of intervals the recording already has. */
  existing: { startRow: number; endRow: number }[];
}

/**
 * Runs the library's gestures over the recording's camera frames and turns each hold into a stretch of raw rows. Only
 * gestures with a label can propose anything. A hold still going when the camera stopped ends at its last frame.
 */
export function proposeIntervals({ definitions, frames, secondFrames = [], alignment, rawTimestampsNs, existing }: ProposeInput): ProposedInterval[] {
  const labelled = definitions.filter((definition) => definition.labelId);
  if (labelled.length === 0 || (frames.length === 0 && secondFrames.length === 0) || rawTimestampsNs.length === 0) return [];
  const detector = new CombinedGestureDetector(labelled);
  const byId = new Map(labelled.map((definition) => [definition.id, definition]));
  const open = new Map<string, number>();
  const holds: { gestureId: string; startMs: number; endMs: number }[] = [];
  const take = (events: ReturnType<CombinedGestureDetector["update"]>) => {
    for (const event of events) {
      if (event.kind === "onset") open.set(event.gestureId, event.atMs);
      else {
        holds.push({ gestureId: event.gestureId, startMs: open.get(event.gestureId) ?? event.atMs, endMs: event.atMs });
        open.delete(event.gestureId);
      }
    }
  };
  // Both cameras' frames in the order they were taken, each camera checked on its own and only the decisions merged.
  const timeline = [
    ...frames.map((frame) => ({ slot: "primary" as CameraSlot, frame, last: frame === frames[frames.length - 1] })),
    ...secondFrames.map((frame) => ({ slot: "secondary" as CameraSlot, frame, last: frame === secondFrames[secondFrames.length - 1] })),
  ].sort((a, b) => a.frame.captureMs - b.frame.captureMs);
  take(detector.setSlotRunning("primary", frames.length > 0, timeline[0].frame.captureMs));
  take(detector.setSlotRunning("secondary", secondFrames.length > 0, timeline[0].frame.captureMs));
  for (const { slot, frame, last } of timeline) {
    take(detector.update(slot, frame.captureMs, frame.hands));
    // A camera whose recording ended is no longer running, so what it last saw does not linger.
    if (last) take(detector.setSlotRunning(slot, false, frame.captureMs));
  }
  const lastMs = timeline[timeline.length - 1].frame.captureMs;
  for (const [gestureId, startMs] of open) holds.push({ gestureId, startMs, endMs: lastMs });
  holds.sort((a, b) => a.startMs - b.startMs);

  const taken = [...existing];
  const proposals: ProposedInterval[] = [];
  for (const hold of holds) {
    const startNs = Math.round((hold.startMs - alignment.offsetMs) * 1e6);
    const endNs = Math.round((hold.endMs - alignment.offsetMs) * 1e6);
    const startRow = lowerBound(rawTimestampsNs, startNs);
    const endRow = lowerBound(rawTimestampsNs, endNs + 1) - 1; // the last row at or before the end
    if (startRow >= rawTimestampsNs.length || endRow < 0 || endRow < startRow) continue; // outside the recording
    const definition = byId.get(hold.gestureId)!;
    const overlaps = taken.some((other) => startRow <= other.endRow && other.startRow <= endRow);
    if (!overlaps) taken.push({ startRow, endRow });
    proposals.push({
      gestureId: definition.id, gestureName: definition.name, labelId: definition.labelId!,
      startMs: hold.startMs, endMs: hold.endMs, startRow, endRow, startNs, endNs, overlaps,
    });
  }

  return proposals;
}

/** The recording-bundle shape of a proposal, ready for the desktop to check and append. */
export function toAnnotationInterval(proposal: ProposedInterval, rawTimestampsNs: number[], nowIso: string): AnnotationInterval {
  return {
    interval_id: crypto.randomUUID(),
    label_id: proposal.labelId,
    requested_start_monotonic_ns: proposal.startNs,
    requested_end_monotonic_ns: proposal.endNs,
    resolved_start: { raw_row: proposal.startRow, source_timestamp_ns: rawTimestampsNs[proposal.startRow] },
    resolved_end: { raw_row: proposal.endRow, source_timestamp_ns: rawTimestampsNs[proposal.endRow] },
    resolution_rule_version: 1,
    creation_mechanism: "camera_proposal",
    curation_status: "unreviewed",
    created_at: nowIso,
    revision: 1,
  };
}
