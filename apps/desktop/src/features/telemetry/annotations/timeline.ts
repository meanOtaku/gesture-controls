import type { AnnotationInterval, CreationMechanism, CurationStatus } from "../../../shared/tauri/recordingBundle";

/**
 * A Timeline Capture interval while it is still being built during a live
 * session (or edited afterward), before it is frozen into the ADR's
 * `AnnotationInterval` wire shape. `endMonotonicNs`/`endRawRow` are `null`
 * while the interval is the currently active (open) one.
 *
 * `startRawRow`/`endRawRow` index into the recording's raw row buffer:
 * `startRawRow` is the first owned row (inclusive), `endRawRow` is one past
 * the last owned row (exclusive) — so an interval owns rows
 * `[startRawRow, endRawRow)`. This makes "zero rows captured" simply
 * `startRawRow === endRawRow`, which callers discard rather than persist.
 */
export type LiveInterval = {
  intervalId: string;
  labelId: string;
  startMonotonicNs: number;
  endMonotonicNs: number | null;
  startRawRow: number;
  endRawRow: number | null;
  creationMechanism: CreationMechanism;
  curationStatus: CurationStatus;
  createdAt: string;
  revision: number;
};

export type ClosedLiveInterval = LiveInterval & { endMonotonicNs: number; endRawRow: number };

function isClosed(interval: LiveInterval): interval is ClosedLiveInterval {
  return interval.endMonotonicNs !== null && interval.endRawRow !== null;
}

/** A closed interval that never captured a row is not real evidence of a label; it must not be persisted. */
export function isDegenerate(interval: LiveInterval): boolean {
  return isClosed(interval) && interval.endRawRow <= interval.startRawRow;
}

/**
 * Enforces the ADR's no-overlap rule across every *other* closed interval.
 * The candidate may be open (still recording); an open interval only
 * conflicts if its start already falls inside another closed interval's
 * range, which cannot happen through the normal close-then-open sequence but
 * is checked here so post-capture edits (which can move a start arbitrarily)
 * stay safe.
 */
export function hasOverlap(candidate: LiveInterval, others: LiveInterval[]): boolean {
  const candidateEnd = candidate.endRawRow ?? Number.POSITIVE_INFINITY;
  return others.some((other) => {
    if (other.intervalId === candidate.intervalId) return false;
    const otherEnd = other.endRawRow ?? Number.POSITIVE_INFINITY;
    return candidate.startRawRow < otherEnd && other.startRawRow < candidateEnd;
  });
}

/** Converts a closed live interval to the immutable ADR wire shape, resolving raw-row boundaries to their source timestamps. */
export function toAnnotationInterval(
  interval: ClosedLiveInterval,
  rows: { timestampNs: string }[],
  resolutionRuleVersion: number,
): AnnotationInterval {
  const lastOwnedRow = interval.endRawRow - 1;
  return {
    interval_id: interval.intervalId,
    label_id: interval.labelId,
    requested_start_monotonic_ns: interval.startMonotonicNs,
    requested_end_monotonic_ns: interval.endMonotonicNs,
    resolved_start: {
      raw_row: interval.startRawRow,
      source_timestamp_ns: Number(rows[interval.startRawRow]?.timestampNs ?? 0),
    },
    resolved_end: {
      raw_row: lastOwnedRow,
      source_timestamp_ns: Number(rows[lastOwnedRow]?.timestampNs ?? 0),
    },
    resolution_rule_version: resolutionRuleVersion,
    creation_mechanism: interval.creationMechanism,
    curation_status: interval.curationStatus,
    created_at: interval.createdAt,
    revision: interval.revision,
  };
}

/**
 * Splits a closed interval at `atRawRow` into two adjacent, non-overlapping
 * intervals with the same label; `atRawRow` becomes the second interval's
 * start. Returns `null` if the split point does not create two non-empty
 * intervals.
 */
export function splitInterval(
  interval: ClosedLiveInterval,
  atRawRow: number,
  newIntervalId: string,
  nowIso: string,
): [LiveInterval, LiveInterval] | null {
  if (atRawRow <= interval.startRawRow || atRawRow >= interval.endRawRow) return null;
  // `requested_*_monotonic_ns` stays the original live-capture value on both
  // halves; only the raw-row-resolved boundaries (the authoritative ones per
  // the ADR) actually move at the split point.
  const first: LiveInterval = { ...interval, endRawRow: atRawRow, revision: interval.revision + 1, createdAt: nowIso };
  const second: LiveInterval = {
    ...interval,
    intervalId: newIntervalId,
    startRawRow: atRawRow,
    startMonotonicNs: interval.startMonotonicNs,
    revision: 1,
    creationMechanism: "timeline_edit",
    createdAt: nowIso,
  };
  return [first, second];
}
