import { OperationFeedback } from "../../components/app/OperationFeedback";
import { telemetryStore } from "../telemetry/store/telemetryStore";
import { startCameraMarking } from "./cameraMarker";
import type { GestureDefinition } from "./definition";

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
 * intervals of that label in the session itself, the way the Mark label button does (see `startCameraMarking`), so the
 * rows, the saved recording and the CSV export all carry them. The label and its gestures are fixed when the recording
 * starts, and the marking runs until the recording is saved or discarded, whichever page is open.
 */
class CameraAssist {
  private enabled = readSaved();
  private armedLabels: string[] = [];
  private readyLabels: string[] = [];
  private readyDefinitions: GestureDefinition[] = [];
  private stopMarking: (() => void) | null = null;
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

  /**
   * The Recorder card says which labels it has checked can be marked right now (camera on, each with a gesture), or
   * none, and those labels' gestures from the library.
   */
  setReady(labels: string | string[] | null, definitions: GestureDefinition[] = []): void {
    this.readyLabels = labels === null ? [] : typeof labels === "string" ? [labels] : [...labels];
    this.readyDefinitions = this.readyLabels.length === 0 ? [] : definitions;
  }
  /** Whether a recording of exactly these labels starting now will be marked: switched on, and the card has checked it can work. */
  willMark(labels: string | string[] | null): boolean {
    const wanted = labels === null ? [] : typeof labels === "string" ? [labels] : labels;
    return this.enabled && wanted.length > 0 && sameLabels(wanted, this.readyLabels);
  }

  /**
   * Called as a recording starts: marks `labels` (one or several) with `definitions`, or with the gestures the card
   * checked for them. Marking runs until `finish` or `disarm`, wherever the person goes in the app meanwhile.
   */
  arm(labels: string | string[], definitions?: GestureDefinition[]): void {
    this.stop();
    this.armedLabels = typeof labels === "string" ? [labels] : [...labels];
    const gestures = definitions ?? (sameLabels(this.armedLabels, this.readyLabels) ? this.readyDefinitions : []);
    this.stopMarking = startCameraMarking(this.armedLabels, gestures);
  }
  disarm(): void {
    this.stop();
    this.armedLabels = [];
  }

  private stop(): void {
    this.stopMarking?.();
    this.stopMarking = null;
  }

  /** The first label being marked by the camera in the recording now under way, or null. */
  armedFor(): string | null {
    return this.armedLabels[0] ?? null;
  }

  /** Every label being marked by the camera in the recording now under way. */
  armedForAll(): string[] {
    return [...this.armedLabels];
  }

  /** Called once the recording is saved: says what the camera marked while it ran. */
  finish(): void {
    this.stop();
    const labels = this.armedLabels;
    this.armedLabels = [];
    if (labels.length === 0) return;
    const operation = "Camera marking";
    const name = (label: string) => label.replaceAll("_", " ");
    const counts = labels.map((label) => ({ label, count: telemetryStore.countCameraIntervals(label) }));
    const total = counts.reduce((sum, entry) => sum + entry.count, 0);
    if (labels.length === 1) {
      const [{ label }] = counts;
      if (total > 0) {
        OperationFeedback.success(operation, `Marked ${total} ${label} interval${total === 1 ? "" : "s"} while recording (unreviewed). Review them in Recordings.`);
      } else {
        OperationFeedback.warning(operation, `The camera did not see the ${label} gesture during this recording, so nothing was marked. The recording was kept.`);
      }
      return;
    }
    const seen = counts.filter((entry) => entry.count > 0).map((entry) => `${entry.count} ${name(entry.label)}`);
    const missed = counts.filter((entry) => entry.count === 0).map((entry) => name(entry.label));
    if (total === 0) {
      OperationFeedback.warning(operation, `The camera did not see any of the ${labels.map(name).join(", ")} gestures during this recording, so nothing was marked. The recording was kept.`);
    } else if (missed.length > 0) {
      OperationFeedback.warning(operation, `Marked ${seen.join(", ")} (unreviewed). The camera did not see ${missed.join(", ")}. Review them in Recordings.`);
    } else {
      OperationFeedback.success(operation, `Marked ${seen.join(", ")} (unreviewed). Review them in Recordings.`);
    }
  }
}

const sameLabels = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((label) => b.includes(label));

export const cameraAssist = new CameraAssist();
