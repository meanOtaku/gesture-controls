import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { WATCH_ORIENTATION_BATCH_EVENT, type WatchOrientationSample } from "../../../shared/protocol/events";
import type { Axis, DeviceKind, DeviceNumbers } from "../recipeModel";
import { MIN_WRIST_RANGE_DEGREES, WristRangeMeter, calibratedNumbers, spanForNumbers, spanOf, type WristRange } from "../wristRange";

interface WristRangeCalibrationProps {
  axis: Axis;
  kind: DeviceKind;
  /** The action's full range in the units the editor shows (100 points of volume). */
  scale: number;
  /** The device's numbers as they stand in the form, or null while one of them is not a number. */
  numbers: DeviceNumbers | null;
  /** The numbers for the measured range, to put in the form; saving the recipe keeps them. */
  onCalibrated: (numbers: DeviceNumbers) => void;
}

const degrees = (value: number) => `${Math.round(value)}°`;

/**
 * Measures how far the wearer comfortably turns the wrist about the recipe's axis, and sets the device so that span
 * covers the whole range of what it controls: from one end of the turn to the other is 0 to 100%.
 */
export function WristRangeCalibration({ axis, kind, scale, numbers, onCalibrated }: WristRangeCalibrationProps) {
  const [range, setRange] = useState<WristRange | null>(null);
  const meter = useRef<WristRangeMeter | null>(null);
  const measuring = range !== null;

  useEffect(() => {
    if (!measuring) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void Promise.resolve(
      listen<WatchOrientationSample[]>(WATCH_ORIENTATION_BATCH_EVENT, ({ payload }) => {
        if (disposed || !meter.current) return;
        let latest: WristRange | null = null;
        for (const sample of payload) latest = meter.current.observe(sample.quaternion);
        if (latest) setRange(latest);
      }),
    )
      .then((fn) => {
        if (disposed) fn?.();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [measuring]);

  const start = () => {
    meter.current = new WristRangeMeter(axis);
    setRange({ now: 0, min: 0, max: 0 });
  };
  const stop = () => {
    meter.current = null;
    setRange(null);
  };

  const saved = numbers ? spanForNumbers(kind, numbers, scale) : null;
  if (!range) {
    return (
      <div className="field">
        <div className="field-head"><span className="field-label">Wrist range</span></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={start}>Calibrate wrist range</Button>
        </div>
        <p className="field-hint">
          {saved !== null && Number.isFinite(saved) ? `Now turning about ${degrees(saved)} takes it from one end to the other. ` : ""}
          Calibrate to turn your wrist through a range that is comfortable for you and make that range the whole scale.
          Saving the recipe keeps it.
        </p>
      </div>
    );
  }

  const span = spanOf(range);
  const enough = span >= MIN_WRIST_RANGE_DEGREES;
  return (
    <div className="field" role="group" aria-label="Wrist range calibration">
      <div className="field-head"><span className="field-label">Wrist range</span></div>
      <p className="field-hint" aria-live="polite">
        Turn your wrist ({axis}) as far as is comfortable one way, then the other way. Now {degrees(range.now)}; from{" "}
        {degrees(range.min)} to {degrees(range.max)}, a range of {degrees(span)}.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={!enough || numbers === null}
          onClick={() => {
            if (numbers) onCalibrated(calibratedNumbers(kind, span, scale, numbers));
            stop();
          }}
        >
          Use this range
        </Button>
        <Button type="button" variant="ghost" onClick={stop}>Cancel</Button>
      </div>
      {!enough && <p className="field-hint">Turn at least {MIN_WRIST_RANGE_DEGREES}° to set a range. Nothing moving? Check that the watch is streaming.</p>}
    </div>
  );
}
