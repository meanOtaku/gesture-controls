import { useEffect, useId, useState } from "react";
import { SectionHeader } from "../../components/app/SectionHeader";
import { OperationFeedback } from "../../components/app/OperationFeedback";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Label } from "../../components/ui/label";
import { parseClockSync, parseHandLandmarks } from "../camera/handLandmarkCsv";
import {
  addCameraProposedIntervals, getRecordingCameraEvidence, listRecordingBundles, loadRecordingBundle,
  type RecordingBundleSummary,
} from "../../shared/tauri/recordingBundle";
import type { GestureDefinition } from "./definition";
import { listGestureDefinitions } from "./gestureLibraryApi";
import { alignClocks, proposeIntervals, toAnnotationInterval, type ClockAlignment, type ProposedInterval } from "./proposals";

type Found = {
  recordingId: string;
  proposals: ProposedInterval[];
  rawTimestampsNs: number[];
  alignment: ClockAlignment;
  frames: number;
  skipped: string[];
};

const seconds = (ns: number, originNs: number) => ((ns - originNs) / 1e9).toFixed(1);

/**
 * Looks for the library's gestures in a saved recording's camera landmarks and offers each hold as a label interval on
 * the watch data. Nothing is added until you choose, and what is added starts unreviewed like any other interval.
 */
export function CameraProposalsPanel() {
  const selectId = useId();
  const [recordings, setRecordings] = useState<RecordingBundleSummary[]>([]);
  const [recordingId, setRecordingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());

  useEffect(() => {
    void listRecordingBundles().then((result) => {
      if (result.status === "ok") setRecordings(result.value);
    });
  }, []);

  const find = async () => {
    setBusy(true);
    setFound(null);
    setMessage(null);
    try {
      const [evidence, detail, definitions] = await Promise.all([
        getRecordingCameraEvidence(recordingId),
        loadRecordingBundle(recordingId),
        listGestureDefinitions().catch(() => [] as GestureDefinition[]),
      ]);
      if (evidence.status === "error") return setMessage(evidence.message);
      if (detail.status === "error") return setMessage(detail.message);
      if (!evidence.value) return setMessage("This recording has no camera data. Turn the camera on in the Recorder before recording to get it.");
      const usable = definitions.filter((definition) => definition.labelId);
      if (usable.length === 0) return setMessage("No gesture in the library is linked to a label yet. Link one in the Gesture library first.");
      const alignment = alignClocks(parseClockSync(evidence.value.clockSync));
      if (!alignment) return setMessage("The camera and watch clocks could not be lined up: this recording has too few clock samples (the watch must be streaming while recording).");
      const frames = parseHandLandmarks(evidence.value.handLandmarks);
      const proposals = proposeIntervals({
        definitions: usable,
        frames,
        alignment,
        rawTimestampsNs: evidence.value.rawTimestampsNs,
        existing: detail.value.annotations.intervals.map((interval) => ({ startRow: interval.resolved_start.raw_row, endRow: interval.resolved_end.raw_row })),
      });
      const skipped = definitions.filter((definition) => !definition.labelId).map((definition) => definition.name);
      setFound({ recordingId, proposals, rawTimestampsNs: evidence.value.rawTimestampsNs, alignment, frames: frames.length, skipped });
      setChosen(new Set(proposals.flatMap((proposal, index) => (proposal.overlaps ? [] : [index]))));
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!found) return;
    setBusy(true);
    const nowIso = new Date().toISOString();
    const intervals = found.proposals.filter((_, index) => chosen.has(index)).map((p) => toAnnotationInterval(p, found.rawTimestampsNs, nowIso));
    const result = await addCameraProposedIntervals(found.recordingId, intervals);
    setBusy(false);
    if (result.status === "error") return setMessage(result.message);
    OperationFeedback.success("Add intervals", `Added ${intervals.length} unreviewed interval${intervals.length === 1 ? "" : "s"}.`);
    setFound(null);
    setMessage(`Added ${intervals.length}. Reselect the recording in the viewer below to see them.`);
  };

  const origin = found?.rawTimestampsNs[0] ?? 0;
  return (
    <Card role="region" aria-label="Camera label proposals" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Label from the camera"
          description="Find your library gestures in a recording's hand landmarks and add them as label intervals."
          help={{
            label: "About camera label proposals",
            content: "Recordings made with the camera on keep the hand landmarks. This runs your Gesture library over them and, using the clock samples saved alongside, finds which watch rows each gesture covers. The lining-up is only as exact as the link was steady, shown below. Proposals you add start unreviewed, so you still approve them like any other label. Gestures with no label, and proposals that overlap an existing interval, are skipped.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="field">
          <div className="field-head"><Label htmlFor={selectId} required>Recording</Label></div>
          <select id={selectId} className="recipe-select" value={recordingId} onChange={(e) => { setRecordingId(e.target.value); setFound(null); setMessage(null); }}>
            <option value="">Choose a recording…</option>
            {recordings.map((r) => <option key={r.recordingId} value={r.recordingId}>{r.recordingId.slice(0, 8)} · {(r.actualDurationMs / 1000).toFixed(0)} s · {r.intervalCount} interval{r.intervalCount === 1 ? "" : "s"}</option>)}
          </select>
        </div>
        <div><Button type="button" disabled={!recordingId || busy} onClick={() => void find()}>{busy && !found ? "Looking…" : "Find gestures"}</Button></div>
        {message && <Alert role="status"><AlertDescription>{message}</AlertDescription></Alert>}
        {found && (
          <>
            <p className="hint" role="status">
              Checked {found.frames} camera frames. Camera and watch lined up to within about {Math.max(1, Math.round(found.alignment.jitterMs))} ms ({found.alignment.samples} clock samples).
              {found.skipped.length > 0 ? ` Skipped, with no label: ${found.skipped.join(", ")}.` : ""}
            </p>
            {found.proposals.length === 0 ? (
              <p className="hint">No gesture was found in this recording.</p>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Proposed intervals">
                {found.proposals.map((p, index) => (
                  <li key={index} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={chosen.has(index)}
                      disabled={p.overlaps}
                      aria-label={`${p.gestureName} at ${seconds(p.startNs, origin)} s`}
                      onCheckedChange={(on) => setChosen((prev) => { const next = new Set(prev); if (on === true) next.add(index); else next.delete(index); return next; })}
                    />
                    <span>
                      <strong>{p.gestureName}</strong> → {p.labelId}, {seconds(p.startNs, origin)}–{seconds(p.endNs, origin)} s of the recording ({p.endRow - p.startRow + 1} rows)
                      {p.overlaps && <small className="text-muted-foreground"> Overlaps an interval already there, so it cannot be added.</small>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {found.proposals.length > 0 && (
              <div><Button type="button" disabled={busy || chosen.size === 0} onClick={() => void add()}>Add {chosen.size} as unreviewed</Button></div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
