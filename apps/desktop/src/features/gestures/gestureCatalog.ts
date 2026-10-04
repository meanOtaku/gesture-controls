import type { HeuristicGesture, Recipe, RecipeStage } from "../../shared/protocol/events";
import { heuristicOf } from "../recipes/recipeModel";

/** One built-in wrist gesture, and the variants the app tells apart. */
export interface WristGesture {
  id: HeuristicGesture;
  name: string;
  how: string;
  /** What the watch has to be streaming for it to work. */
  needs: string;
  options: { id: string; label: string }[];
}

export const WRIST_GESTURES: readonly WristGesture[] = [
  { id: "shake", name: "Shake", how: "Shake your wrist back and forth a few times.", needs: "the watch's acceleration sensor", options: [{ id: "shake", label: "Shake" }] },
  {
    id: "swipe", name: "Swipe", how: "Flick your hand sharply in a direction. Left and right run along your forearm; up and down follow gravity.", needs: "the watch's acceleration and orientation",
    options: [{ id: "left", label: "Left" }, { id: "right", label: "Right" }, { id: "up", label: "Up" }, { id: "down", label: "Down" }],
  },
  { id: "tap", name: "Tap", how: "Knock a finger on the watch while your arm is still. A single tap is confirmed after about half a second.", needs: "the watch's acceleration sensor", options: [{ id: "single", label: "Tap" }, { id: "double", label: "Double tap" }] },
  { id: "roll", name: "Roll", how: "Twist your wrist quickly about your forearm, like turning a key.", needs: "the watch's orientation sensor", options: [{ id: "clockwise", label: "Clockwise" }, { id: "counterClockwise", label: "Counter-clockwise" }] },
  { id: "pitch", name: "Pitch", how: "Nod your hand up or down at the wrist, like a wave.", needs: "the watch's orientation sensor", options: [{ id: "up", label: "Up" }, { id: "down", label: "Down" }] },
];

const stageGesture = (stage: RecipeStage): HeuristicGesture | null => (stage.kind === "hold" ? heuristicOf(stage.hold) : null);

/** The enabled recipes that use a built-in gesture, by name. */
export function recipesUsingGesture(recipes: Recipe[], gesture: HeuristicGesture): string[] {
  return recipes.filter((recipe) => recipe.enabled && recipe.stages.some((stage) => stageGesture(stage) === gesture)).map((recipe) => recipe.name);
}

/** The enabled recipes that have a step on this model label, by name. */
export function recipesUsingLabel(recipes: Recipe[], label: string): string[] {
  return recipes.filter((recipe) => recipe.enabled && recipe.stages.some((stage) => stage.kind === "model" && stage.label === label)).map((recipe) => recipe.name);
}

/** The enabled recipes that use the STEM button, by name. */
export function recipesUsingStem(recipes: Recipe[]): string[] {
  return recipes.filter((recipe) => recipe.enabled && recipe.stages.some((stage) => stage.kind === "hold" && stage.hold === "stemButton")).map((recipe) => recipe.name);
}
