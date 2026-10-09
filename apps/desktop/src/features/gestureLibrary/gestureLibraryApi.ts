import { invoke } from "@tauri-apps/api/core";
import type { GestureDefinition } from "./definition";

/** Sent when gestures are saved or deleted, so the running camera picks the change up. */
export const GESTURE_LIBRARY_CHANGED = "gesture-library-changed";

/** The desktop keeps the definitions in a file and checks every one before saving (see `gesture_library.rs`). */
export const listGestureDefinitions = () => invoke<GestureDefinition[]>("list_gesture_definitions");
export const saveGestureDefinition = (definition: GestureDefinition) => invoke<GestureDefinition[]>("save_gesture_definition", { definition });
export const deleteGestureDefinition = (id: string) => invoke<GestureDefinition[]>("delete_gesture_definition", { id });
