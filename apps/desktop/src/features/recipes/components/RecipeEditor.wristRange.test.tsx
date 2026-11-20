import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalibrationLocation, Quaternion, Recipe } from "../../../shared/protocol/events";
import { pinchVolumeRecipe } from "../recipeModel";
import { WristRangeMeter, calibratedNumbers, spanForNumbers, twistDegrees } from "../wristRange";
import { RecipeEditor } from "./RecipeEditor";

let orientationHandler: ((event: { payload: unknown }) => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, fn: (event: { payload: unknown }) => void) => {
    if (name === "watch-orientation-batch") orientationHandler = fn;
    return Promise.resolve(() => { if (orientationHandler === fn) orientationHandler = undefined; });
  }),
}));

afterEach(() => {
  cleanup();
  orientationHandler = undefined;
});

/** Turned `degrees` about the forearm (the watch's x axis). */
const rolled = (degrees: number): Quaternion => {
  const half = (degrees * Math.PI) / 360;
  return [Math.cos(half), Math.sin(half), 0, 0];
};

const locations: CalibrationLocation[] = [{ id: "topRight", name: "Top right", calibrated: true, builtin: false }];

const volumeKnob = (): Recipe => ({
  ...pinchVolumeRecipe(locations),
  stages: [
    { kind: "headAt", location: "topRight" },
    { kind: "modelPair", startLabel: "pinch_in", endLabel: "pinch_out" },
    { kind: "drive", axis: "roll", deadZoneDegrees: 1, invert: false },
  ],
  device: { kind: "rotationKnob", fractionPerDegree: 1 / 300 },
  action: "volume",
});

describe("the wrist range", () => {
  it("is measured about the recipe's axis from where calibration began, past half a turn too", () => {
    expect(twistDegrees(rolled(0), rolled(30), "roll")).toBeCloseTo(30);
    expect(twistDegrees(rolled(0), rolled(30), "yaw")).toBeCloseTo(0);
    const meter = new WristRangeMeter("roll");
    for (const at of [10, 0, -40, -20, 60, 120, 170, -170, 20]) meter.observe(rolled(at + 10));
    // The first sample is the start: from there the wrist went 50 one way and 180 the other, through the seam.
    expect(meter.current.min).toBeCloseTo(-50);
    expect(meter.current.max).toBeCloseTo(180);
  });

  it("becomes device numbers for which the whole span is the whole scale", () => {
    expect(calibratedNumbers("rotationKnob", 80, 100, { a: 0.33, b: 0 }).a).toBeCloseTo(1.25);
    expect(calibratedNumbers("verticalFader", 60, 100, { a: 45, b: 50 })).toEqual({ a: 60, b: 100 });
    expect(calibratedNumbers("stepKnob", 100, 100, { a: 15, b: 5 })).toEqual({ a: 5, b: 5 });
    for (const kind of ["rotationKnob", "verticalFader", "horizontalFader", "stepKnob"] as const) {
      const numbers = calibratedNumbers(kind, 90, 100, { a: 15, b: 5 });
      expect(spanForNumbers(kind, numbers, 100)).toBeCloseTo(90, 0);
    }
  });

  it("is calibrated in the editor from the watch and saved with the recipe", async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    render(<RecipeEditor recipe={volumeKnob()} locations={locations} onSave={onSave} onCancel={() => undefined} />);
    expect(screen.getByText(/Now turning about 300° takes it from one end to the other/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Calibrate wrist range" }));
    await waitFor(() => expect(orientationHandler).toBeDefined());
    const use = screen.getByRole("button", { name: "Use this range" });
    expect(use).toBeDisabled();
    act(() => orientationHandler?.({ payload: [-30, -50, 0, 40, 30].map((at) => ({ quaternion: rolled(at + 30) })) }));
    expect(screen.getByText(/a range of 90°/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use this range" }));
    expect(screen.getByText(/Now turning about 90° takes it from one end to the other/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0] as Recipe;
    expect(saved.device.kind).toBe("rotationKnob");
    expect(Number(saved.device.fractionPerDegree)).toBeCloseTo(1 / 90, 4);
  });
});
