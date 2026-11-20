import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { HEAD_POSE_EVENT, type HeadPosePayload } from "../../../shared/protocol/events";
import { HeadRangeMeter, MIN_HEAD_RANGE_DEGREES, headRangeOf, type HeadSweep } from "../headRange";

interface HeadRangeCalibrationProps {
  /** The measured range in degrees, to put in the form; saving the recipe keeps it. */
  onCalibrated: (range: { across: number; up: number }) => void;
}

const degrees = (value: number) => `${Math.round(value)}°`;

/**
 * Measures how far the wearer turns the head to look from one edge of the screen to the other, left to right and top
 * to bottom, and makes that the head pointer's range: looking across that far crosses the whole screen.
 */
export function HeadRangeCalibration({ onCalibrated }: HeadRangeCalibrationProps) {
  const [sweep, setSweep] = useState<HeadSweep | null>(null);
  const meter = useRef<HeadRangeMeter | null>(null);
  const measuring = sweep !== null;

  useEffect(() => {
    if (!measuring) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void Promise.resolve(
      listen<HeadPosePayload>(HEAD_POSE_EVENT, ({ payload }) => {
        if (disposed || !meter.current) return;
        setSweep(meter.current.observe(payload.yawDeg, payload.pitchDeg));
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
    meter.current = new HeadRangeMeter();
    setSweep(meter.current.current);
  };
  const stop = () => {
    meter.current = null;
    setSweep(null);
  };

  if (!sweep) {
    return (
      <div className="field">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={start}>Calibrate head range</Button>
        </div>
        <p className="field-hint">
          Calibrate to look at the left and right edges of the screen, then the top and bottom, and make those turns the
          whole screen. Saving the recipe keeps it.
        </p>
      </div>
    );
  }

  const range = headRangeOf(sweep);
  const enough = range.across >= MIN_HEAD_RANGE_DEGREES && range.up >= MIN_HEAD_RANGE_DEGREES;
  return (
    <div className="field" role="group" aria-label="Head range calibration">
      <p className="field-hint" aria-live="polite">
        Look at the left edge of the screen and the right, then the top and the bottom. Across: {degrees(range.across)}{" "}
        (now {degrees(sweep.yaw.now)}); up and down: {degrees(range.up)} (now {degrees(sweep.pitch.now)}).
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={!enough}
          onClick={() => {
            onCalibrated(range);
            stop();
          }}
        >
          Use this range
        </Button>
        <Button type="button" variant="ghost" onClick={stop}>Cancel</Button>
      </div>
      {!enough && (
        <p className="field-hint">
          Turn at least {MIN_HEAD_RANGE_DEGREES}° each way to set a range. Nothing moving? Check that the headphones are
          connected and switched on under Settings.
        </p>
      )}
    </div>
  );
}
