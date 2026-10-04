import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { LABEL_DETECTIONS_EVENT, type DetectionReport } from "../model-lab/labelModels";

export interface LabelDetections {
  /** Labels being detected right now (in Monitor as well as Live). */
  detected: ReadonlySet<string>;
  /** How many times each label has started this session. */
  counts: ReadonlyMap<string, number>;
}

/** Follows the label runtime's detections, so a model can be demoed in Monitor without anything acting. */
export function useLabelDetections(desktopAvailable: boolean): LabelDetections {
  const [state, setState] = useState<LabelDetections>({ detected: new Set(), counts: new Map() });

  useEffect(() => {
    if (!desktopAvailable) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void Promise.resolve(
      listen<DetectionReport>(LABEL_DETECTIONS_EVENT, ({ payload }) => {
        if (disposed) return;
        setState((current) => {
          const detected = new Set(current.detected);
          const counts = new Map(current.counts);
          for (const event of payload.events) {
            if (event.kind === "rising") {
              detected.add(event.label);
              counts.set(event.label, (counts.get(event.label) ?? 0) + 1);
            } else if (event.kind === "falling") {
              detected.delete(event.label);
            }
          }
          return { detected, counts };
        });
      }),
    )
      .then((fn) => {
        if (disposed) fn?.();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktopAvailable]);

  return state;
}
