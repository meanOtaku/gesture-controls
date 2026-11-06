import { useState } from "react";
import { Button } from "../../components/ui/button";
import type { Span } from "./labellingModel";

export function LabelTimingEditor({ span, min, max, onApply }: { span: Span; min: number; max: number; onApply: (span: Span) => void }) {
  const [start, setStart] = useState(String(span.startMs / 1000));
  const [end, setEnd] = useState(String(span.endMs / 1000));
  const [duration, setDuration] = useState(String((span.endMs - span.startMs) / 1000));
  const from = Number(start) * 1000;
  const to = Number(end) * 1000;
  const valid = start.trim() !== "" && end.trim() !== "" && duration.trim() !== "" && Number(duration) > 0 && Number.isFinite(from) && Number.isFinite(to) && from >= min && to <= max && to > from;
  return <fieldset className="labelling-timing"><legend>Selected manual label timing</legend>
    <label>Start (seconds)<input type="number" step="0.001" value={start} onChange={(e) => { setStart(e.target.value); setDuration(String(Number(end) - Number(e.target.value))); }} /></label>
    <label>End (seconds)<input type="number" step="0.001" value={end} onChange={(e) => { setEnd(e.target.value); setDuration(String(Number(e.target.value) - Number(start))); }} /></label>
    <label>Duration (seconds)<input type="number" step="0.001" value={duration} onChange={(e) => { setDuration(e.target.value); setEnd(String(Number(start) + Number(e.target.value))); }} /></label>
    <Button size="sm" disabled={!valid} onClick={() => onApply({ ...span, startMs: from, endMs: to })}>Apply timing</Button>
    {!valid && <p role="alert">Enter a positive interval within the recording and between neighbouring labels.</p>}
  </fieldset>;
}
