import { describe, expect, it } from "vitest";
import type { Recipe } from "../../shared/protocol/events";
import { recipesUsingGesture, recipesUsingLabel, recipesUsingStem } from "./gestureCatalog";

const recipe = (name: string, enabled: boolean, stages: Recipe["stages"]): Recipe => ({
  id: name, name, enabled, action: "playPause", stages, device: { kind: "rotationKnob" },
});

describe("which recipes use a gesture", () => {
  const recipes = [
    recipe("Swipe next", true, [{ kind: "hold", hold: "swipeRight" }]),
    recipe("Swipe off", false, [{ kind: "hold", hold: "swipeLeft" }]),
    recipe("Snap play", true, [{ kind: "headAt", location: "center" }, { kind: "model", label: "snap", hold: "oneShot" }]),
    recipe("Stem volume", true, [{ kind: "hold", hold: "stemButton" }]),
  ];

  it("names only enabled recipes, by gesture family", () => {
    expect(recipesUsingGesture(recipes, "swipe")).toEqual(["Swipe next"]);
    expect(recipesUsingGesture(recipes, "shake")).toEqual([]);
  });

  it("finds model labels and the STEM button", () => {
    expect(recipesUsingLabel(recipes, "snap")).toEqual(["Snap play"]);
    expect(recipesUsingLabel(recipes, "other")).toEqual([]);
    expect(recipesUsingStem(recipes)).toEqual(["Stem volume"]);
  });
});
