import { describe, expect, it } from "vitest";
import { applyActivity, MAX_RECENT, type RecipeActivityState } from "./useRecipeActivity";

const empty: RecipeActivityState = { byRecipe: new Map(), recent: [] };
const at = (seconds: number) => new Date(2026, 10, 12, 10, 0, seconds);

describe("applyActivity", () => {
  it("marks a dial in use from its start to its end and counts each start", () => {
    let state = applyActivity(empty, { recipe: "volume", moment: "started" }, at(1), 0);
    expect(state.byRecipe.get("volume")).toEqual({ inUse: true, uses: 1, lastAt: at(1) });
    state = applyActivity(state, { recipe: "volume", moment: "ended" }, at(4), 1);
    expect(state.byRecipe.get("volume")).toEqual({ inUse: false, uses: 1, lastAt: at(1) });
    state = applyActivity(state, { recipe: "volume", moment: "started" }, at(9), 2);
    expect(state.byRecipe.get("volume")?.uses).toBe(2);
  });

  it("counts a button press without leaving it in use, newest first, and keeps only the latest moments", () => {
    let state = applyActivity(empty, { recipe: "next", moment: "fired" }, at(1), 0);
    expect(state.byRecipe.get("next")).toEqual({ inUse: false, uses: 1, lastAt: at(1) });
    for (let i = 1; i <= MAX_RECENT + 5; i += 1) state = applyActivity(state, { recipe: "next", moment: "fired" }, at(1 + i), i);
    expect(state.recent).toHaveLength(MAX_RECENT);
    expect(state.recent[0].id).toBe(MAX_RECENT + 5);
    expect(state.byRecipe.get("next")?.uses).toBe(MAX_RECENT + 6);
  });
});
