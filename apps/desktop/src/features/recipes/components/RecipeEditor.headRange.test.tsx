import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalibrationLocation } from "../../../shared/protocol/events";
import { HeadRangeMeter, headRangeOf } from "../headRange";
import { snapPointerRecipe } from "../recipeModel";
import { RecipeEditor } from "./RecipeEditor";

let poseHandler: ((event: { payload: unknown }) => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, fn: (event: { payload: unknown }) => void) => {
    if (name === "head-pose-updated") poseHandler = fn;
    return Promise.resolve(() => { if (poseHandler === fn) poseHandler = undefined; });
  }),
}));

afterEach(() => {
  cleanup();
  poseHandler = undefined;
});

const locations: CalibrationLocation[] = [{ id: "center", name: "Screen center", calibrated: true, builtin: true }];

describe("the head range", () => {
  it("is measured from where calibration began, across the back of the circle too", () => {
    const meter = new HeadRangeMeter();
    for (const [yaw, pitch] of [[170, 0], [-170, 5], [150, -10], [175, 3]]) meter.observe(yaw, pitch);
    // 170 to -170 is 20 degrees on round, not 340 back.
    expect(meter.current.yaw.max).toBeCloseTo(20);
    expect(meter.current.yaw.min).toBeCloseTo(-20);
    expect(headRangeOf(meter.current)).toEqual({ across: 40, up: 15 });
  });

  it("is set or calibrated for a head pointer and saved with it, and a hand pointer has none", async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    render(<RecipeEditor recipe={snapPointerRecipe(locations)} locations={locations} onSave={onSave} onCancel={() => undefined} />);
    expect(screen.queryByLabelText("Head range across")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Speed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Head" }));
    // The range takes the place of the speed.
    expect(screen.queryByLabelText("Speed")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Head range across")).toHaveValue(40);
    fireEvent.click(screen.getByRole("button", { name: "Calibrate head range" }));
    await waitFor(() => expect(poseHandler).toBeDefined());
    expect(screen.getByRole("button", { name: "Use this range" })).toBeDisabled();
    for (const [yaw, pitch] of [[10, 0], [-14, 0], [22, 0], [0, 9], [0, -9]]) {
      act(() => poseHandler?.({ payload: { yawDeg: yaw, pitchDeg: pitch } }));
    }
    expect(screen.getByRole("group", { name: "Head range calibration" })).toHaveTextContent("Across: 36°");
    fireEvent.click(screen.getByRole("button", { name: "Use this range" }));
    expect(screen.getByLabelText("Head range across")).toHaveValue(36);
    expect(screen.getByLabelText("Head range up and down")).toHaveValue(18);
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].stages[1]).toMatchObject({ source: "head", headRange: { acrossDegrees: 36, upDegrees: 18 } });
  });

  it("is kept when a saved head pointer is opened again", async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    const recipe = snapPointerRecipe(locations);
    const stage = { ...(recipe.stages[1] as Extract<(typeof recipe.stages)[number], { kind: "pointer" }>), source: "head" as const, headRange: { acrossDegrees: 50, upDegrees: 30 } };
    render(<RecipeEditor recipe={{ ...recipe, stages: [recipe.stages[0], stage] }} locations={locations} onSave={onSave} onCancel={() => undefined} />);
    expect(screen.getByLabelText("Head range across")).toHaveValue(50);
    fireEvent.click(screen.getByRole("radio", { name: "Hand" }));
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].stages[1].headRange).toBeUndefined();
  });
});
