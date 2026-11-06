import { useRef, useState, type PointerEvent } from "react";
import { snapTo, formatSeconds, type Span } from "./labellingModel";
import type { View } from "./SignalLane";

export type LabelDrag = "move" | "start" | "end";

/** Keep an edit inside the recording and between its neighbours. Moving preserves duration. */
export function dragLabel(spans: Span[], index: number, mode: LabelDrag, delta: number, duration: number): Span {
  const span = spans[index];
  const low = index === 0 ? 0 : spans[index - 1].endMs + 1e-6;
  const high = index === spans.length - 1 ? duration : spans[index + 1].startMs - 1e-6;
  const min = Math.min(1, span.endMs - span.startMs);
  if (mode === "start") return { ...span, startMs: Math.max(low, Math.min(span.endMs - min, span.startMs + delta)) };
  if (mode === "end") return { ...span, endMs: Math.min(high, Math.max(span.startMs + min, span.endMs + delta)) };
  const shift = Math.max(low - span.startMs, Math.min(high - span.endMs, delta));
  return { ...span, startMs: span.startMs + shift, endMs: span.endMs + shift };
}

export function EditableLabelRail({ spans, view, duration, colorOf, nameOf, onPreview, onCommit, onSelect, snap, snapPoints }: {
  snap?: boolean; snapPoints?: number[];
  spans: Span[]; view: View; duration: number; colorOf: (label: string) => string; nameOf: (label: string) => string;
  onPreview: (spans: Span[] | null) => void; onCommit: (spans: Span[]) => void; onSelect: (span: Span) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const drag = useRef<{ original: Span[]; index: number; mode: LabelDrag; x: number; scale: number; next: Span[] } | null>(null);
  const [draft, setDraft] = useState<Span[] | null>(null);
  const begin = (event: PointerEvent<HTMLElement>, index: number, mode: LabelDrag) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const width = rail.current?.getBoundingClientRect().width ?? 0;
    if (!width) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { original: spans, index, mode, x: event.clientX, scale: (view.endMs - view.startMs) / width, next: spans };
    onSelect(spans[index]);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    let delta = (event.clientX - current.x) * current.scale;
    if (snap && !event.altKey) {
      const original = current.original[current.index];
      const points = (snapPoints ?? []).filter((point) => point !== original.startMs && point !== original.endMs);
      const edge = current.mode === "end" ? original.endMs : original.startMs;
      const threshold = Math.abs(current.scale) * 8;
      delta = snapTo(edge + delta, points, threshold) - edge;
      if (current.mode === "move") {
        const rawDelta = (event.clientX - current.x) * current.scale;
        const endDelta = snapTo(original.endMs + rawDelta, points, threshold) - original.endMs;
        if (endDelta !== rawDelta && (delta === rawDelta || Math.abs(endDelta - rawDelta) < Math.abs(delta - rawDelta))) delta = endDelta;
      }
    }
    const edited = dragLabel(current.original, current.index, current.mode, delta, duration);
    current.next = current.original.map((span, index) => index === current.index ? edited : span);
    setDraft(current.next); onPreview(current.next); onSelect(edited);
  };
  const finish = (cancel: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null; setDraft(null); onPreview(null);
    if (!cancel) onCommit(current.next);
    else onSelect(current.original[current.index]);
  };
  return <div ref={rail} className="labelling-rail" role="list" aria-label="By hand labels">
    <span className="labelling-lane-name">By hand</span>
    {(draft ?? spans).map((span, index) => {
      if (span.endMs < view.startMs || span.startMs > view.endMs) return null;
      const left = Math.max(0, (span.startMs - view.startMs) / (view.endMs - view.startMs) * 100);
      const right = Math.min(100, (span.endMs - view.startMs) / (view.endMs - view.startMs) * 100);
      const name = nameOf(span.label);
      return <div key={index} role="listitem" className="labelling-span labelling-span-editable" style={{ left: `${left}%`, width: `max(18px, ${right - left}%)`, background: colorOf(span.label) }}
        title={`${name}: ${formatSeconds(span.startMs)} to ${formatSeconds(span.endMs)}. Drag to move; drag either edge to resize.`}
        onPointerMove={move} onPointerUp={() => finish(false)} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}>
        <button type="button" className="labelling-drag-body" aria-label={`Move ${name}`} onClick={() => onSelect(span)} onPointerDown={(e) => begin(e, index, "move")}>{name}</button>
        {(["start", "end"] as const).map((edge) => <button key={edge} type="button" className={`labelling-resize labelling-resize-${edge}`} aria-label={`Resize ${name} ${edge}`} onPointerDown={(e) => begin(e, index, edge)} />)}
      </div>;
    })}
  </div>;
}
