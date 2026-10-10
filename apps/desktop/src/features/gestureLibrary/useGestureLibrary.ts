import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DatasetLabel } from "../model-lab/types";
import type { GestureDefinition } from "./definition";
import { GESTURE_LIBRARY_CHANGED, deleteGestureDefinition, listGestureDefinitions, saveGestureDefinition } from "./gestureLibraryApi";

/** The saved gestures and the label catalogue they can be linked to. Saving and deleting return the new list. */
export function useGestureLibrary() {
  const [definitions, setDefinitions] = useState<GestureDefinition[]>([]);
  const [labels, setLabels] = useState<DatasetLabel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [list, catalogue] = await Promise.all([listGestureDefinitions(), invoke<DatasetLabel[]>("list_model_labels")]);
        if (!live) return;
        setDefinitions(list);
        setLabels(Array.isArray(catalogue) ? catalogue : []);
      } catch (err) {
        if (live) setError(String(err));
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /** Returns the problem in words, or null when it was saved. */
  const save = useCallback(async (definition: GestureDefinition): Promise<string | null> => {
    try {
      const next = await saveGestureDefinition(definition);
      setDefinitions(next);
      setError(null);
      window.dispatchEvent(new Event(GESTURE_LIBRARY_CHANGED));
      return null;
    } catch (err) {
      return String(err);
    }
  }, []);

  const remove = useCallback(async (id: string): Promise<string | null> => {
    try {
      setDefinitions(await deleteGestureDefinition(id));
      window.dispatchEvent(new Event(GESTURE_LIBRARY_CHANGED));
      return null;
    } catch (err) {
      return String(err);
    }
  }, []);

  return { definitions, labels, error, loaded, save, remove };
}
