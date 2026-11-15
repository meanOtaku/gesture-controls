import { useState } from "react";
import { Button } from "../../components/ui/button";
import type { Span } from "./labellingModel";

/** The selected hand label: its exact timing, and a way to delete it (Undo brings it back). */
export function LabelTimingEditor({ span, min, max, onApply, onDelete }: { span: Span; min: number; max: number; onApply: (span: Span) => void; onDelete?: () => void }) {
  const [start, setStart] = useState(String(span.startMs / 1000));
  const [end, setEnd] = useState(String(span.endMs / 1000));
  const [duration, setDuration] = useState(String((span.endMs - span.startMs) / 1000));
  const from = Number(start) * 1000;
  const to = Number(end) * 1000;
  const valid = start.trim() !== "" && end.trim() !== "" && duration.trim() !== "" && Number(duration) > 0 && Number.isFinite(from) && Number.isFinite(to) && from >= min && to <= max && to > from;
  return <fieldset className="labelling-timing"><legend>Selected manual label</legend>
    <label>Start (seconds)<input type="number" step="0.001" value={start} onChange={(e) => { setStart(e.target.value); setDuration(String(Number(end) - Number(e.target.value))); }} /></label>
    <label>End (seconds)<input type="number" step="0.001" value={end} onChange={(e) => { setEnd(e.target.value); setDuration(String(Number(e.target.value) - Number(start))); }} /></label>
    <label>Duration (seconds)<input type="number" step="0.001" value={duration} onChange={(e) => { setDuration(e.target.value); setEnd(String(Number(start) + Number(e.target.value))); }} /></label>
    <Button size="sm" disabled={!valid} onClick={() => onApply({ ...span, startMs: from, endMs: to })}>Apply timing</Button>
    {onDelete && <Button size="sm" variant="destructive" onClick={onDelete}>Delete label <kbd className="labelling-key">⌫</kbd></Button>}
    {!valid && <p role="alert">Enter a positive interval within the recording and between neighbouring labels.</p>}
  </fieldset>;
}
