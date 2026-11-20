import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalibrationLocation } from "../../../shared/protocol/events";
import { chainProblem, describeRecipe, pointerLabelsProblem, recipeUsesLabel, snapPointerRecipe } from "../recipeModel";
import { RecipeEditor } from "./RecipeEditor";

afterEach(cleanup);

const locations: CalibrationLocation[] = [{ id: "center", name: "Screen center", calibrated: true, builtin: true }];

describe("pointer recipes", () => {
  it("start from a snap that switches pointer mode on and the pinch labels that click", () => {
    const recipe = snapPointerRecipe(locations);
    expect(recipe.action).toBe("pointer");
    expect(recipe.stages).toEqual([
      { kind: "model", label: "snap_fingers", hold: "oneShot" },
      { kind: "pointer", pixelsPerDegree: 25, pressLabel: "pinch_in", holdLabel: "pinch_hold", releaseLabel: "pinch_out", lookbackMs: 400, mode: "trackpad" },
    ]);
    expect(describeRecipe(recipe, (id) => id)).toBe(
      "Model “snap_fingers” (once) → Hand moves the pointer (pinch_in then pinch_out clicks, pinch_hold drags) → Mouse pointer",
    );
    for (const label of ["snap_fingers", "pinch_in", "pinch_hold", "pinch_out"]) expect(recipeUsesLabel(recipe, label)).toBe(true);
    expect(recipeUsesLabel(recipe, "pinch")).toBe(false);
  });

  it("need a step to switch them on, no grab/release pair, and valid, different press and release labels", () => {
    expect(chainProblem([], locations, false, true)).toMatch(/switches pointer mode on/);
    expect(chainProblem([{ kind: "modelPair", startLabel: "pinch_in", endLabel: "pinch_out" }], locations, false, true)).toMatch(/grab\/release/);
    expect(chainProblem([{ kind: "model", label: "snap_fingers", hold: "oneShot" }], locations, false, true)).toBeNull();
    expect(pointerLabelsProblem({ pressLabel: "pinch_in", holdLabel: "pinch_hold", releaseLabel: "pinch_out" })).toBeNull();
    expect(pointerLabelsProblem({ pressLabel: "pinch", holdLabel: "pinch_hold", releaseLabel: "pinch" })).toMatch(/different/);
    expect(pointerLabelsProblem({ pressLabel: "Pinch In", holdLabel: "pinch_hold", releaseLabel: "pinch_out" })).toMatch(/lowercase/);
  });

  it("are edited with the pointer's own settings instead of a wrist rotation and device", async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    render(<RecipeEditor recipe={snapPointerRecipe(locations)} locations={locations} onSave={onSave} onCancel={() => undefined} />);
    expect(screen.getByRole("group", { name: "Then point" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Then turn your wrist" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Device")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Step 1 model timing")).toHaveValue("oneShot");
    fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Click look-back"), { target: { value: "300" } });
    fireEvent.change(screen.getByLabelText("Hold label"), { target: { value: "pinch_held" } });
    expect(screen.getByText(/Turn the palm to the side to lift/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Mouse" }));
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].stages).toEqual([
      { kind: "model", label: "snap_fingers", hold: "oneShot" },
      { kind: "pointer", pixelsPerDegree: 40, pressLabel: "pinch_in", holdLabel: "pinch_held", releaseLabel: "pinch_out", lookbackMs: 300, mode: "mouse", source: "watch", reverseAcross: false, reverseUp: false },
    ]);
  });

  it("do not save with the same press and release label", () => {
    const onSave = vi.fn().mockResolvedValue(null);
    render(<RecipeEditor recipe={snapPointerRecipe(locations)} locations={locations} onSave={onSave} onCancel={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Release label"), { target: { value: "pinch_in" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/different/);
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saved before the choice existed, still move the pointer like a mouse", async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    const recipe = snapPointerRecipe(locations);
    const { mode: _mode, ...older } = recipe.stages[1] as Extract<(typeof recipe.stages)[number], { kind: "pointer" }>;
    render(<RecipeEditor recipe={{ ...recipe, stages: [recipe.stages[0], older] }} locations={locations} onSave={onSave} onCancel={() => undefined} />);
    expect(screen.getByText(/always moves the pointer/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].stages[1].mode).toBe("mouse");
  });

  it("can follow the head instead of the hand, with either direction reversed", async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    render(<RecipeEditor recipe={snapPointerRecipe(locations)} locations={locations} onSave={onSave} onCancel={() => undefined} />);
    expect(screen.getByRole("radio", { name: "Hand" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Head" }));
    expect(screen.getByText(/Turn your head left and right/)).toBeInTheDocument();
    // There is no palm to turn, so the trackpad choice goes away.
    expect(screen.queryByRole("radio", { name: "Trackpad" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Reverse left and right" }));
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0];
    expect(saved.stages[1]).toMatchObject({ kind: "pointer", source: "head", reverseAcross: true, reverseUp: false });
    expect(describeRecipe(saved, (id) => id)).toMatch(/Head moves the pointer/);
  });
});
