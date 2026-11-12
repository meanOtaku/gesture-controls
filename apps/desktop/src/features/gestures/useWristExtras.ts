import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { HAMMER_DETECTED_EVENT, SHAKE_DETECTED_EVENT, WIGGLE_DETECTED_EVENT, type ShakeAxis } from "../../shared/protocol/events";

export interface WristExtras {
  /** The direction of the latest shake, or null when it had none (or there has been no shake). */
  shakeAxis: ShakeAxis | null;
  wiggles: number;
  hammers: number;
}

/** Follows the shake's direction, wiggles and hammer blows as the app recognises them, for the Gestures page. */
export function useWristExtras(desktopAvailable: boolean): WristExtras {
  const [state, setState] = useState<WristExtras>({ shakeAxis: null, wiggles: 0, hammers: 0 });

  useEffect(() => {
    if (!desktopAvailable) return;
    let disposed = false;
    const stops: (() => void)[] = [];
    const follow = <T,>(event: string, apply: (current: WristExtras, payload: T) => WristExtras) => {
      void Promise.resolve(listen<T>(event, ({ payload }) => { if (!disposed) setState((current) => apply(current, payload)); }))
        .then((stop) => { if (disposed) stop?.(); else if (stop) stops.push(stop); })
        .catch(() => undefined);
    };
    follow<ShakeAxis | null>(SHAKE_DETECTED_EVENT, (current, axis) => ({ ...current, shakeAxis: axis ?? null }));
    follow<null>(WIGGLE_DETECTED_EVENT, (current) => ({ ...current, wiggles: current.wiggles + 1 }));
    follow<null>(HAMMER_DETECTED_EVENT, (current) => ({ ...current, hammers: current.hammers + 1 }));
    return () => { disposed = true; stops.forEach((stop) => stop()); };
  }, [desktopAvailable]);

  return state;
}
