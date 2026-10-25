import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Span } from "./labellingModel";
import type { View } from "./SignalLane";

/** A moment to mark on the overview: a mistake, a problem, a suggestion. */
export interface OverviewMark {
  atMs: number;
  color: string;
  title: string;
}

/**
 * The whole recording at a glance: every label, recorded and by hand, the marks worth a look, and a box over the part in
 * view. Click to look somewhere else; drag the box to move along.
 */
export function OverviewStrip({ durationMs, recorded, byHand, marks, view, colorOf, onView }: {
  durationMs: number;
  recorded: Span[];
  byHand: Span[];
  marks: OverviewMark[];
  view: View;
  colorOf: (label: string) => string;
  onView: (view: View) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const total = Math.max(1, durationMs);
  const pct = (ms: number) => `${(Math.min(total, Math.max(0, ms)) / total) * 100}%`;
  const width = view.endMs - view.startMs;

  const centreAt = (clientX: number) => {
    const box = strip.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    const at = ((clientX - box.left) / box.width) * total;
    const start = Math.min(Math.max(0, at - width / 2), Math.max(0, total - width));
    onView({ startMs: start, endMs: start + width });
  };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragging.current = true;
    centreAt(event.clientX);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current) centreAt(event.clientX);
  };

  const bar = (spans: Span[], row: "top" | "bottom") =>
    spans.map((span, index) => (
      <span
        key={`${row}-${span.startMs}-${index}`}
        className={`overview-span overview-${row}`}
        style={{ left: pct(span.startMs), width: `max(1px, calc(${pct(span.endMs)} - ${pct(span.startMs)}))`, background: colorOf(span.label) }}
      />
    ));

  return (
    <div
      ref={strip}
      className="labelling-overview"
      role="slider"
      aria-label="Whole recording"
      aria-valuemin={0}
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(view.startMs)}
      aria-valuetext={`Showing ${(view.startMs / 1000).toFixed(1)} to ${(view.endMs / 1000).toFixed(1)} s of ${(total / 1000).toFixed(1)} s`}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={() => (dragging.current = false)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const step = (event.key === "ArrowLeft" ? -1 : 1) * width * 0.5;
        const start = Math.min(Math.max(0, view.startMs + step), Math.max(0, total - width));
        onView({ startMs: start, endMs: start + width });
      }}
    >
      {bar(recorded, "top")}
      {bar(byHand, "bottom")}
      {marks.map((mark, index) => (
        <i key={`mark-${mark.atMs}-${index}`} className="overview-mark" style={{ left: pct(mark.atMs), background: mark.color }} title={mark.title} />
      ))}
      <span className="overview-view" style={{ left: pct(view.startMs), width: `max(4px, calc(${pct(view.endMs)} - ${pct(view.startMs)}))` }} />
    </div>
  );
}
