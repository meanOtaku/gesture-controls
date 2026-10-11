import { OperationFeedback } from "../../components/app/OperationFeedback";
import { telemetryStore } from "../telemetry/store/telemetryStore";

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
}

/**
 * Camera marking. It is on by default and the choice is remembered, but it only takes effect when it can work: the camera
 * is on and the chosen label has a gesture in the library (the Recorder card checks that and says which label it has
 * verified, see `setReady`). Then the recording is a timeline, and while it runs the camera opens and closes unreviewed
 * intervals of that label in the session itself, the way the Mark label button does (see `CameraAssistCard`), so the
 * rows, the saved recording and the CSV export all carry them. The label is remembered when the recording starts, so
 * changing the picker mid-recording changes nothing.
 */
class CameraAssist {
  private enabled = readSaved();
  private armedLabel: string | null = null;
  private readyLabel: string | null = null;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { enabled: this.enabled };

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

  /** The label being marked by the camera in the recording now under way, or null. */
  armedFor(): string | null {
    return this.armedLabel;
  }

  /** Called once the recording is saved: says what the camera marked while it ran. */
  finish(): void {
    const label = this.armedLabel;
    this.armedLabel = null;
    if (!label) return;
    const operation = "Camera marking";
    const count = telemetryStore.countCameraIntervals();
    if (count > 0) {
      OperationFeedback.success(operation, `Marked ${count} ${label} interval${count === 1 ? "" : "s"} while recording (unreviewed). Review them in Recordings.`);
    } else {
      OperationFeedback.warning(operation, `The camera did not see the ${label} gesture during this recording, so nothing was marked. The recording was kept.`);
    }
  }
}

export const cameraAssist = new CameraAssist();
