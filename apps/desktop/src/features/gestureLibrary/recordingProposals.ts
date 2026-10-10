import { parseClockSync, parseHandLandmarks } from "../camera/handLandmarkCsv";
import {
  addCameraProposedIntervals, getRecordingCameraEvidence, loadRecordingBundle,
} from "../../shared/tauri/recordingBundle";
import type { GestureDefinition } from "./definition";
import { alignClocks, proposeIntervals, toAnnotationInterval, type ClockAlignment, type ProposedInterval } from "./proposals";

export type Found = {
  recordingId: string;
  proposals: ProposedInterval[];
  rawTimestampsNs: number[];
  alignment: ClockAlignment;
  frames: number;
  /** How many cameras the recording had. */
  cameras: number;
};

export type FindResult = { ok: true; found: Found } | { ok: false; message: string };

/** Runs the given gestures over a saved recording's camera landmarks. A reason in words when it cannot. */
export async function findProposals(recordingId: string, definitions: GestureDefinition[]): Promise<FindResult> {
  const [evidence, detail] = await Promise.all([getRecordingCameraEvidence(recordingId), loadRecordingBundle(recordingId)]);
  if (evidence.status === "error") return { ok: false, message: evidence.message };
  if (detail.status === "error") return { ok: false, message: detail.message };
  if (!evidence.value) return { ok: false, message: "This recording has no camera data. Turn the camera on in the Recorder before recording to get it." };
  const usable = definitions.filter((definition) => definition.labelId);
  if (usable.length === 0) return { ok: false, message: "No gesture in the library is linked to a label yet. Link one in the Gesture library first." };
  const alignment = alignClocks(parseClockSync(evidence.value.clockSync));
  if (!alignment) return { ok: false, message: "The camera and watch clocks could not be lined up: this recording has too few clock samples (the watch must be streaming while recording)." };
  const frames = parseHandLandmarks(evidence.value.handLandmarks);
  const secondFrames = evidence.value.handLandmarksSecond ? parseHandLandmarks(evidence.value.handLandmarksSecond) : [];
  const proposals = proposeIntervals({
    definitions: usable,
    frames,
    secondFrames,
    alignment,
    rawTimestampsNs: evidence.value.rawTimestampsNs,
    existing: detail.value.annotations.intervals.map((interval) => ({ startRow: interval.resolved_start.raw_row, endRow: interval.resolved_end.raw_row })),
  });
  return { ok: true, found: { recordingId, proposals, rawTimestampsNs: evidence.value.rawTimestampsNs, alignment, frames: frames.length + secondFrames.length, cameras: secondFrames.length > 0 ? 2 : 1 } };
}

/** Adds the chosen proposals to the recording as unreviewed intervals. Null when added, else the problem. */
export async function addProposals(found: Found, chosen: ProposedInterval[]): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const result = await addCameraProposedIntervals(found.recordingId, chosen.map((p) => toAnnotationInterval(p, found.rawTimestampsNs, nowIso)));
  return result.status === "error" ? result.message : null;
}

export type AutoMarkOutcome =
  | { kind: "added"; count: number; jitterMs: number }
  | { kind: "none"; frames: number }
  | { kind: "skipped"; reason: string };

/**
 * After a recording is saved: finds the gesture in its camera data and adds every hold as an unreviewed interval. The
 * recording itself is untouched if nothing is found or anything goes wrong.
 */
export async function autoMarkRecording(recordingId: string, definitions: GestureDefinition[]): Promise<AutoMarkOutcome> {
  const result = await findProposals(recordingId, definitions);
  if (!result.ok) return { kind: "skipped", reason: result.message };
  const usable = result.found.proposals.filter((proposal) => !proposal.overlaps);
  if (usable.length === 0) return { kind: "none", frames: result.found.frames };
  const problem = await addProposals(result.found, usable);
  if (problem) return { kind: "skipped", reason: problem };
  return { kind: "added", count: usable.length, jitterMs: result.found.alignment.jitterMs };
}
