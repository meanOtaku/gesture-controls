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
      { kind: "pointer", pixelsPerDegree: 25, pressLabel: "pinch_in", holdLabel: "pinch_hold", releaseLabel: "pinch_out", lookbackMs: 400 },
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
    expect(screen.getByRole("group", { name: "Then point with your hand" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Then turn your wrist" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Device")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Step 1 model timing")).toHaveValue("oneShot");
    fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Click look-back"), { target: { value: "300" } });
    fireEvent.change(screen.getByLabelText("Hold label"), { target: { value: "pinch_held" } });
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].stages).toEqual([
      { kind: "model", label: "snap_fingers", hold: "oneShot" },
      { kind: "pointer", pixelsPerDegree: 40, pressLabel: "pinch_in", holdLabel: "pinch_held", releaseLabel: "pinch_out", lookbackMs: 300 },
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
});
