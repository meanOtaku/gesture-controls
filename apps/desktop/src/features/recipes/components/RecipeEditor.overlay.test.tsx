import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalibrationLocation, Recipe } from "../../../shared/protocol/events";
import { anchorForLocation, lookedAtAnchor, pinchVolumeRecipe, snapPointerRecipe } from "../recipeModel";
import { RecipeEditor } from "./RecipeEditor";

afterEach(cleanup);

const locations: CalibrationLocation[] = [
  { id: "center", name: "Screen center", calibrated: true, builtin: true },
  { id: "topLeft", name: "Top left", calibrated: true, builtin: false },
];

const brightnessAtTopLeft = (): Recipe => ({
  ...pinchVolumeRecipe(locations),
  action: "brightness",
  stages: [
    { kind: "headAt", location: "topLeft" },
    { kind: "modelPair", startLabel: "pinch_in", endLabel: "pinch_out" },
    { kind: "drive", axis: "roll", deadZoneDegrees: 0, invert: false },
  ],
});

describe("where a recipe's overlay is shown", () => {
  it("is read from the location's id, like the app does", () => {
    expect(anchorForLocation("topLeft")).toBe("topLeft");
    expect(anchorForLocation("bottom_right")).toBe("bottomRight");
    expect(anchorForLocation("leftEdge")).toBe("left");
    expect(anchorForLocation("rightSide2")).toBe("right");
    expect(anchorForLocation("screenCentre")).toBe("center");
    expect(anchorForLocation("desk")).toBeNull();
    expect(anchorForLocation("topBottom")).toBeNull();
    expect(lookedAtAnchor([{ kind: "headAt", location: "desk" }, { kind: "headAt", location: "bottomLeft" }])).toBe("bottomLeft");
    expect(lookedAtAnchor([])).toBe("topRight");
  });

  it("follows where the recipe is looked at unless another place is chosen", async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    render(<RecipeEditor recipe={brightnessAtTopLeft()} locations={locations} onSave={onSave} onCancel={() => undefined} />);
    const select = screen.getByLabelText("Show it on screen at");
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: "Where you look (Top left)" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].overlayAt).toBeUndefined();

    fireEvent.change(select, { target: { value: "bottomRight" } });
    fireEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0].overlayAt).toBe("bottomRight");
  });

  it("is not asked for a recipe that shows nothing on screen", () => {
    render(<RecipeEditor recipe={snapPointerRecipe(locations)} locations={locations} onSave={vi.fn()} onCancel={() => undefined} />);
    expect(screen.queryByLabelText("Show it on screen at")).not.toBeInTheDocument();
  });
});
