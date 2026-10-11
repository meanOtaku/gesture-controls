import { useEffect } from "react";
import { telemetryStore } from "../telemetry/store/telemetryStore";

/**
 * While a recording is under way and the camera is armed for a label, writes what the camera sees into the session itself:
 * the label is on while it sees the gesture and off when it lets go, starting where the gesture began (`sinceMs`), just
 * like holding the Mark label button. Used wherever a recording is made with camera marking.
 */
export function useCameraMarking(armed: string | null, recordingState: string | undefined, seen: boolean, sinceMs: number | null): void {
  useEffect(() => {
    if (!armed || recordingState !== "recording") return;
    if (seen) telemetryStore.setTimelineLabel(armed, "camera_proposal", sinceMs !== null && Number.isFinite(sinceMs) ? sinceMs : undefined);
    else if (telemetryStore.getActiveTimelineLabel() === armed) telemetryStore.setTimelineLabel(null);
  }, [armed, recordingState, seen, sinceMs]);
}
