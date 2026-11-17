import { useEffect, useMemo, useRef, useState } from "react";
import { useHover, type HoverStore } from "./hoverStore";
import { lowerBound, minMaxBuckets, rowsToDraw, type Span } from "./labellingModel";

export interface View {
  startMs: number;
  endMs: number;
}

type SignalLaneProps = {
  name: string;
  timesMs: number[];
  values: (number | null)[];
  view: View;
  width: number;
  height: number;
  /** Hand labels, shaded behind the trace in their label's colour. */
  spans: Span[];
  colorOf: (label: string) => string;
  selection: View | null;
  /** Where the pointer is: only this lane's cursor layer redraws when it moves. */
  hover: HoverStore;
  /** Scale the trace to what is in view, rather than to the whole recording (the default, which stays put as you move). */
  fitToView?: boolean;
  /** A fixed scale (a model's score: 0 to 1), whatever the other choices. */
  scale?: { low: number; high: number };
  /** A level to mark across the lane (a model's threshold). */
  guide?: number;
};

/** Sizes a canvas's backing store for `width` x `height` CSS pixels, only when it differs: assigning `width` or `height`
 * (even the same value) throws the old buffer away and allocates a new one, which WebKit does in graphics memory. Done on
 * every hover, it took the Labelling page past 1 GB and kept the processor busy. Returns the 2D context, ready to draw in
 * CSS pixels and cleared. */
function prepare(element: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const ratio = window.devicePixelRatio || 1;
  const w = Math.round(width * ratio);
  const h = Math.round(height * ratio);
  if (element.width !== w) element.width = w;
  if (element.height !== h) element.height = h;
  const context = element.getContext?.("2d");
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}

/** How far outside the window a lane starts drawing, so it is ready by the time it scrolls in. */
const DRAW_MARGIN_PX = 300;

/** Whether `element` is on screen (or within DRAW_MARGIN_PX of it). Always true where IntersectionObserver is missing. */
function useOnScreen(element: React.RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const target = element.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setOnScreen(entries.some((e) => e.isIntersecting)), {
      rootMargin: `${DRAW_MARGIN_PX}px 0px`,
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return onScreen;
}

/** Gives a canvas's graphics memory back (a 0 x 0 backing store). */
function release(element: HTMLCanvasElement | null): void {
  if (element && (element.width !== 0 || element.height !== 0)) {
    element.width = 0;
    element.height = 0;
  }
}

/**
 * One column of the recording as a trace over the view. Each pixel column draws the lowest and highest value of the rows
 * it covers, so a half-hour recording draws as fast as a minute and no spike is skipped. The scale fits what is in view.
 */
export function SignalLane({ name, timesMs, values, view, width: outerWidth, height: outerHeight, spans, colorOf, selection, hover, fitToView = false, scale, guide }: SignalLaneProps) {
  const hoverMs = useHover(hover);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Drawn only near the screen: a lane scrolled away gives its graphics memory back and does not redraw (a recording can
  // have a dozen lanes, each a canvas the width of the page).
  const lane = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(lane);
  // The cursor (its line and the value under it) is drawn on a canvas of its own over the trace, so moving the pointer
  // redraws only that: the trace redraws when the data, the view or the size changes.
  const cursor = useRef<HTMLCanvasElement>(null);
  // The trace's vertical scale as last drawn, for the cursor's dot (null: nothing drawn to mark).
  const drawnScale = useRef<{ bottom: number; top: number; color: string } | null>(null);
  // `width` and `height` are the lane's outer size; the trace is drawn inside its 1 px border, so every lane is exactly as
  // tall as the others and nothing spills into the next one.
  const width = Math.max(0, outerWidth - 2);
  const height = Math.max(0, outerHeight - 2);
  // The column's lowest and highest value over the whole recording: the fixed scale, so moving or zooming only moves along
  // time and never rescales the trace.
  const whole = useMemo(() => {
    let low = Infinity;
    let high = -Infinity;
    for (const value of values) {
      if (value === null || !Number.isFinite(value)) continue;
      if (value < low) low = value;
      if (value > high) high = value;
    }
    return { low, high };
  }, [values]);

  useEffect(() => {
    const element = canvas.current;
    drawnScale.current = null;
    if (!onScreen) return release(element);
    if (!element || width <= 0) return;
    const context = prepare(element, width, height);
    if (!context) return;
    const span = Math.max(1e-9, view.endMs - view.startMs);
    const x = (ms: number) => ((ms - view.startMs) / span) * width;

    for (const labelled of spans) {
      if (labelled.endMs < view.startMs || labelled.startMs > view.endMs) continue;
      context.fillStyle = colorOf(labelled.label);
      context.globalAlpha = 0.18;
      context.fillRect(x(labelled.startMs), 0, Math.max(1, x(labelled.endMs) - x(labelled.startMs)), height);
    }
    context.globalAlpha = 1;
    if (selection) {
      context.fillStyle = "rgba(255, 200, 80, 0.22)";
      const [from, to] = [Math.min(selection.startMs, selection.endMs), Math.max(selection.startMs, selection.endMs)];
      context.fillRect(x(from), 0, Math.max(1, x(to) - x(from)), height);
    }

    // Fewer samples in view than pixels (zoomed in): a line through each sample, from the one before the view to the one
    // after it, so it reaches both edges. More (zoomed out): each pixel column's lowest and highest value.
    const [first, last] = rowsToDraw(timesMs, view.startMs, view.endMs);
    const sparse = last - first + 1 <= width;
    const buckets = sparse ? [] : minMaxBuckets(timesMs, values, view.startMs, view.endMs, Math.max(1, Math.floor(width)));
    let low = scale ? scale.low : fitToView ? Infinity : whole.low;
    let high = scale ? scale.high : fitToView ? -Infinity : whole.high;
    if (scale || !fitToView) {
      // Fixed to the whole recording: nothing in view changes it.
    } else if (sparse) {
      for (let i = first; i <= last; i += 1) {
        const value = values[i];
        if (value === null || !Number.isFinite(value)) continue;
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    } else {
      for (const bucket of buckets) {
        if (!bucket) continue;
        low = Math.min(low, bucket.min);
        high = Math.max(high, bucket.max);
      }
    }
    if (Number.isFinite(low)) {
      const pad = high > low ? (high - low) * 0.08 : Math.max(1, Math.abs(low) * 0.01);
      const [bottom, top] = [low - pad, high + pad];
      const y = (value: number) => height - ((value - bottom) / (top - bottom)) * height;
      context.strokeStyle = getComputedStyle(element).color || "#65e6ff";
      drawnScale.current = { bottom, top, color: context.strokeStyle as string };
      context.fillStyle = context.strokeStyle;
      context.lineWidth = 1.25;
      context.beginPath();
      if (sparse) {
        let drawing = false;
        for (let i = first; i <= last; i += 1) {
          const value = values[i];
          if (value === null || !Number.isFinite(value)) {
            drawing = false; // a blank cell breaks the line rather than bridging it
            continue;
          }
          if (drawing) context.lineTo(x(timesMs[i]), y(value));
          else context.moveTo(x(timesMs[i]), y(value));
          drawing = true;
        }
        context.stroke();
        // Close enough to tell the samples apart: mark each one.
        if ((last - first + 1) * 6 <= width) {
          for (let i = first; i <= last; i += 1) {
            const value = values[i];
            if (value === null || !Number.isFinite(value)) continue;
            context.beginPath();
            context.arc(x(timesMs[i]), y(value), 2, 0, Math.PI * 2);
            context.fill();
          }
        }
      } else {
        let started = false;
        buckets.forEach((bucket, column) => {
          if (!bucket) return;
          const px = column + 0.5;
          if (started) context.lineTo(px, y(bucket.max));
          else context.moveTo(px, y(bucket.max));
          context.lineTo(px, y(bucket.min));
          started = true;
        });
        context.stroke();
      }
      context.fillStyle = "rgba(160, 160, 160, 0.9)";
      context.font = "10px ui-monospace, monospace";
      context.fillText(formatValue(high), 4, 11);
      context.fillText(formatValue(low), 4, height - 3);
      if (guide !== undefined && guide >= bottom && guide <= top) {
        context.strokeStyle = "rgba(255, 200, 80, 0.8)";
        context.setLineDash([4, 4]);
        context.beginPath();
        context.moveTo(0, y(guide));
        context.lineTo(width, y(guide));
        context.stroke();
        context.setLineDash([]);
        context.fillStyle = "rgba(255, 200, 80, 0.9)";
        context.fillText(`threshold ${formatValue(guide)}`, 4, Math.max(11, y(guide) - 3));
      }
    }
  }, [timesMs, values, view, width, height, spans, colorOf, selection, fitToView, whole, scale, guide, onScreen]);

  // The cursor: a line where the pointer is, and the nearest sample's value marked on the trace and written beside it.
  // Runs after the trace's effect (declared after it), so it uses the scale just drawn.
  useEffect(() => {
    const element = cursor.current;
    if (!onScreen) return release(element);
    if (!element || width <= 0) return;
    const context = prepare(element, width, height);
    if (!context || hoverMs === null || hoverMs < view.startMs || hoverMs > view.endMs) return;
    const span = Math.max(1e-9, view.endMs - view.startMs);
    const x = (ms: number) => ((ms - view.startMs) / span) * width;
    const scaleNow = drawnScale.current;
    if (scaleNow) {
      const y = (value: number) => height - ((value - scaleNow.bottom) / (scaleNow.top - scaleNow.bottom)) * height;
      const after = lowerBound(timesMs, hoverMs);
      const nearest = [after - 1, after]
        .filter((i) => i >= 0 && i < timesMs.length && values[i] !== null && Number.isFinite(values[i]))
        .sort((a, b) => Math.abs(timesMs[a] - hoverMs) - Math.abs(timesMs[b] - hoverMs))[0];
      if (nearest !== undefined) {
        const value = values[nearest] as number;
        context.fillStyle = "rgba(255, 255, 255, 0.95)";
        context.beginPath();
        context.arc(x(timesMs[nearest]), y(value), 3, 0, Math.PI * 2);
        context.fill();
        context.font = "10px ui-monospace, monospace";
        const text = formatValue(value);
        const textX = x(hoverMs) + 6 + context.measureText(text).width > width ? x(hoverMs) - 6 - context.measureText(text).width : x(hoverMs) + 6;
        context.fillText(text, textX, 22);
      }
    }
    context.fillStyle = "rgba(255, 255, 255, 0.6)";
    context.fillRect(Math.round(x(hoverMs)), 0, 1, height);
  }, [timesMs, values, view, width, height, hoverMs, fitToView, whole, scale, guide, spans, selection, colorOf, onScreen]);

  return (
    <div ref={lane} className="labelling-lane" style={{ height: outerHeight }}>
      <span className="labelling-lane-name">{name}</span>
      <canvas ref={canvas} style={{ width, height }} aria-label={`${name} over the view`} role="img" />
      <canvas ref={cursor} className="labelling-lane-cursor" style={{ width, height }} aria-hidden="true" />
    </div>
  );
}

function formatValue(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return Math.round(value).toLocaleString("en-US");
  if (magnitude >= 1) return value.toFixed(2);
  return value.toPrecision(3);
}
