import { invoke } from "@tauri-apps/api/core";
import type { GestureDefinition } from "./definition";

/** Sent when gestures are saved or deleted, so the running camera picks the change up. */
export const GESTURE_LIBRARY_CHANGED = "gesture-library-changed";

/** The desktop keeps the definitions in a file and checks every one before saving (see `gesture_library.rs`). */
export const listGestureDefinitions = () => invoke<GestureDefinition[]>("list_gesture_definitions");
export const saveGestureDefinition = (definition: GestureDefinition) => invoke<GestureDefinition[]>("save_gesture_definition", { definition });
export const deleteGestureDefinition = (id: string) => invoke<GestureDefinition[]>("delete_gesture_definition", { id });

/** The recorded frames of a gesture as the desktop keeps them: one value per measurement per frame. */
export interface SampleSet {
  measures: string[];
  rows: (number | null)[][];
}
export const listGestureSamples = () => invoke<Record<string, SampleSet>>("list_gesture_samples");
export const saveGestureSamples = (id: string, samples: SampleSet) => invoke<void>("save_gesture_samples", { id, samples });
