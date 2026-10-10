import { OperationFeedback } from "../../components/app/OperationFeedback";
import { telemetryStore } from "../telemetry/store/telemetryStore";
import { definitionsForLabel } from "./definition";
import { listGestureDefinitions } from "./gestureLibraryApi";
import { autoMarkRecording } from "./recordingProposals";

const KEY = "cameraMarkingOn";
const readSaved = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== "0"; // on unless the person switched it off
  } catch {
    return true;
  }
};

interface Snapshot {
  enabled: boolean;
  /** Camera marking is running on the recording just saved. */
  marking: boolean;
}

/**
 * Camera marking. It is on by default and the choice is remembered, but it only takes effect when it can work: the camera
 * is on and the chosen label has a gesture in the library (the Recorder card checks that and says which label it has
 * verified, see `setReady`). Then the recording is made as a timeline with no manual intervals, and when it is saved the
 * camera's holds of that gesture are added as unreviewed intervals, in the saved recording and in the session's own data
 * (so the CSV export has them). The label is remembered when the recording starts, so changing the picker mid-recording
 * changes nothing.
 */
class CameraAssist {
  private enabled = readSaved();
  private armedLabel: string | null = null;
  private readyLabel: string | null = null;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { enabled: this.enabled, marking: false };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = (): Snapshot => this.snapshot;

  private publish(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      // The choice still holds for this session.
    }
    this.publish({ enabled: on });
  }
  isEnabled(): boolean {
    return this.enabled;
  }

  /** The Recorder card says which label it has checked can be marked right now (camera on, gesture present), or none. */
  setReady(label: string | null): void {
    this.readyLabel = label;
  }
  /** Whether a recording of `label` starting now will be marked: switched on, and the card has checked it can work. */
  willMark(label: string | null): boolean {
    return this.enabled && label !== null && this.readyLabel === label;
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
    this.publish({ marking: true });
    try {
      const definitions = definitionsForLabel(await listGestureDefinitions(), label);
      const outcome = await autoMarkRecording(recordingId, definitions);
      if (outcome.kind === "added") {
        // Put the marks in the session too, so exporting its CSV carries them.
        telemetryStore.addCameraMarkedIntervals(outcome.intervals, outcome.rawRowCount);
        OperationFeedback.success(operation, `Marked ${outcome.count} ${label} interval${outcome.count === 1 ? "" : "s"} (unreviewed; the camera and watch line up to about ${Math.max(1, Math.round(outcome.jitterMs))} ms). Review them in Recordings.`);
      } else if (outcome.kind === "none") {
        OperationFeedback.warning(operation, `The camera did not see the ${label} gesture in this recording, so nothing was marked. The recording was kept.`);
      } else {
        OperationFeedback.warning(operation, `Nothing was marked: ${outcome.reason}`);
      }
    } catch (error) {
      OperationFeedback.error(operation, String(error));
    } finally {
      this.publish({ marking: false });
    }
  }
}

export const cameraAssist = new CameraAssist();
