import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { pinchVolumeRecipe } from "../recipeModel";
import { RecipeEditor } from "./RecipeEditor";

afterEach(cleanup);

it("grabs and releases with any held gesture's start and end", () => {
  const onSave = vi.fn().mockResolvedValue(null);
  render(<RecipeEditor recipe={pinchVolumeRecipe([])} locations={[]} onSave={onSave} onCancel={() => undefined}
    heldGestures={[{ id: "pinch", name: "Pinch", start: "pinch_in", end: "pinch_out" }, { id: "fist", name: "Fist", start: "fist_in", end: "fist_out" }]} />);
  const gesture = screen.getByLabelText("Step 2 held gesture");
  expect(gesture).toHaveValue("pinch");
  fireEvent.change(gesture, { target: { value: "fist" } });
  expect(screen.getByLabelText("Step 2 grab label")).toHaveValue("fist_in");
  expect(screen.getByLabelText("Step 2 release label")).toHaveValue("fist_out");
  // Typed labels of no held gesture show as other labels.
  fireEvent.change(screen.getByLabelText("Step 2 release label"), { target: { value: "open" } });
  expect(gesture).toHaveValue("");
  fireEvent.change(gesture, { target: { value: "fist" } });
  expect(screen.getByLabelText("Step 2 release label")).toHaveValue("fist_out");
});
