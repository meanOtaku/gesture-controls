import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { RECIPE_ACTIVITY_EVENT, type RecipeActivity } from "../../shared/protocol/events";

export interface RecipeUse {
  /** A dial recipe is following the wrist right now. */
  inUse: boolean;
  /** How many times it started or fired this session. */
  uses: number;
  /** When it last started or fired. */
  lastAt: Date | null;
}

export interface RecentUse {
  id: number;
  recipe: string;
  moment: RecipeActivity["moment"];
  at: Date;
}

export interface RecipeActivityState {
  byRecipe: ReadonlyMap<string, RecipeUse>;
  /** The latest moments, newest first. */
  recent: readonly RecentUse[];
}

export const MAX_RECENT = 30;
const NEVER: RecipeUse = { inUse: false, uses: 0, lastAt: null };

/** The state after one more thing a recipe did. */
export function applyActivity(state: RecipeActivityState, activity: RecipeActivity, at: Date, id: number): RecipeActivityState {
  const before = state.byRecipe.get(activity.recipe) ?? NEVER;
  const counts = activity.moment !== "ended";
  const byRecipe = new Map(state.byRecipe);
  byRecipe.set(activity.recipe, {
    inUse: activity.moment === "started",
    uses: before.uses + (counts ? 1 : 0),
    lastAt: counts ? at : before.lastAt,
  });
  return { byRecipe, recent: [{ id, recipe: activity.recipe, moment: activity.moment, at }, ...state.recent].slice(0, MAX_RECENT) };
}

/** Follows what the recipes are doing: which is in use, how often each was used, and the latest moments. */
export function useRecipeActivity(): RecipeActivityState {
  const [state, setState] = useState<RecipeActivityState>({ byRecipe: new Map(), recent: [] });
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    let next = 0;
    void Promise.resolve(listen<RecipeActivity>(RECIPE_ACTIVITY_EVENT, ({ payload }) => {
      if (!disposed) setState((current) => applyActivity(current, payload, new Date(), next++));
    }))
      .then((fn) => { if (disposed) fn?.(); else stop = fn; })
      .catch(() => undefined);
    return () => { disposed = true; stop?.(); };
  }, []);
  return state;
}
