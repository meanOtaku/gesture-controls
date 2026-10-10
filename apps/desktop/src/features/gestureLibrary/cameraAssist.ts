import { OperationFeedback } from "../../components/app/OperationFeedback";
import { listGestureDefinitions } from "./gestureLibraryApi";
import { autoMarkRecording } from "./recordingProposals";

/**
 * "Let the camera mark it": while on, a recording of a label that has a library gesture is made as a timeline recording
 * with no manual intervals, and when it is saved the camera's holds of that gesture are added as unreviewed intervals.
 * The label is remembered at the moment the recording starts, so changing the picker mid-recording changes nothing.
 */
class CameraAssist {
  private enabled = false;
  private armedLabel: string | null = null;
  private listeners = new Set<() => void>();
  private snapshot = { enabled: false };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = () => this.snapshot;

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.snapshot = { enabled: on };
    this.listeners.forEach((listener) => listener());
  }
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Called as a recording starts. */
  arm(label: string): void {
    this.armedLabel = label;
  }
  disarm(): void {
    this.armedLabel = null;
  }

  /** Called once the recording is saved: marks the gesture in it and says what happened. */
  async finish(recordingId: string): Promise<void> {
    const label = this.armedLabel;
    this.armedLabel = null;
    if (!label) return;
    const operation = "Camera marking";
    try {
      const definitions = (await listGestureDefinitions()).filter((definition) => definition.labelId === label);
      const outcome = await autoMarkRecording(recordingId, definitions);
      if (outcome.kind === "added") {
        OperationFeedback.success(operation, `Marked ${outcome.holds} ${label} hold${outcome.holds === 1 ? "" : "s"}${outcome.closing + outcome.opening > 0 ? ` with ${outcome.closing} closing and ${outcome.opening} opening stretch${outcome.closing + outcome.opening === 1 ? "" : "es"}` : ""} (unreviewed; the camera and watch line up to about ${Math.max(1, Math.round(outcome.jitterMs))} ms). Review them in Recordings.`);
      } else if (outcome.kind === "none") {
        OperationFeedback.warning(operation, `The camera did not see the ${label} gesture in this recording, so nothing was marked. The recording was kept.`);
      } else {
        OperationFeedback.warning(operation, `Nothing was marked: ${outcome.reason}`);
      }
    } catch (error) {
      OperationFeedback.error(operation, String(error));
    }
  }
}

export const cameraAssist = new CameraAssist();
