import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DatasetLabel } from "../model-lab/types";
import type { MeasureSample } from "./calibration";
import type { GestureDefinition } from "./definition";
import { GESTURE_LIBRARY_CHANGED, deleteGestureDefinition, listGestureDefinitions, listGestureSamples, saveGestureDefinition, saveGestureSamples } from "./gestureLibraryApi";
import { fromSampleSet, toSampleSet } from "./sampleStore";

/** The saved gestures and the label catalogue they can be linked to. Saving and deleting return the new list. */
export function useGestureLibrary() {
  const [definitions, setDefinitions] = useState<GestureDefinition[]>([]);
  const [labels, setLabels] = useState<DatasetLabel[]>([]);
  /** The frames each gesture was calibrated on, by gesture id; a gesture calibrated before they were kept has none. */
  const [samples, setSamples] = useState<Record<string, MeasureSample[]>>({});
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
        try {
          const saved = await listGestureSamples();
          if (live && saved && typeof saved === "object") setSamples(Object.fromEntries(Object.entries(saved).map(([id, set]) => [id, fromSampleSet(set)])));
        } catch {
          // Without saved frames the library still works; it just cannot check gestures against each other.
        }
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

  /**
   * Returns the problem in words, or null when it was saved. `frames`, the frames of the gesture just recorded, are kept
   * with it so later gestures can be checked against this one.
   */
  const save = useCallback(async (definition: GestureDefinition, frames?: MeasureSample[]): Promise<string | null> => {
    try {
      const next = await saveGestureDefinition(definition);
      setDefinitions(next);
      setError(null);
      if (frames && frames.length > 0) {
        // A new gesture's id is made by the desktop; names are unique, so the name finds it.
        const saved = definition.id ? next.find((d) => d.id === definition.id) : next.find((d) => d.name.toLowerCase() === definition.name.trim().toLowerCase());
        if (saved) {
          try {
            await saveGestureSamples(saved.id, toSampleSet(frames));
            setSamples((current) => ({ ...current, [saved.id]: fromSampleSet(toSampleSet(frames)) }));
          } catch {
            // The gesture is saved; only the check against other gestures lacks its frames.
          }
        }
      }
      window.dispatchEvent(new Event(GESTURE_LIBRARY_CHANGED));
      return null;
    } catch (err) {
      return String(err);
    }
  }, []);

  const remove = useCallback(async (id: string): Promise<string | null> => {
    try {
      setDefinitions(await deleteGestureDefinition(id));
      setSamples(({ [id]: _dropped, ...rest }) => rest);
      window.dispatchEvent(new Event(GESTURE_LIBRARY_CHANGED));
      return null;
    } catch (err) {
      return String(err);
    }
  }, []);

  return { definitions, labels, samples, error, loaded, save, remove };
}
