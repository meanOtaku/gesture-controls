import type { CameraSlot, HandFrame } from "../camera/handTypes";
import type { GestureDefinition } from "./definition";
import { CombinedGestureDetector, type CombineMode } from "./combinedDetector";

export interface CameraReport {
  /** Every gesture the camera is running now; empty with the camera off. */
  known: string[];
  /** Those it sees right now. */
  held: string[];
  /** Those it began to see in this frame. */
  risen: string[];
}

/** While the camera is on, say something at least this often, so the desktop knows the window is alive. */
export const HEARTBEAT_MS = 250;

/**
 * Tells the desktop which library gestures the camera sees, for recipes that use them. Sends when something changes and
 * otherwise as a heartbeat; if the heartbeat stops (camera off, window frozen or hidden), the desktop lets every camera
 * gesture go by itself, so a stuck window cannot leave one held.
 */
export class CameraGestureReporter {
  private detector = new CombinedGestureDetector([]);
  private slotOn: Record<CameraSlot, boolean> = { primary: false, secondary: false };
  private known: string[] = [];
  private lastHeld: string[] = [];
  private lastSentMs = -Infinity;
  private on = false;
  private reportedOn = false;

  constructor(private readonly send: (report: CameraReport) => void, private readonly clock: () => number) {}

  setDefinitions(definitions: GestureDefinition[]): void {
    const usable = definitions.filter((definition) => definition.conditions.length > 0);
    this.detector.setDefinitions(usable);
    this.known = usable.map((definition) => definition.id);
    if (this.on) this.flush([], this.currentHeld());
  }

  /** How two cameras' decisions are merged: any camera sees a gesture, or all running cameras do. */
  setMode(mode: CombineMode): void {
    this.detector.setMode(mode);
    if (this.on) this.flush([], this.currentHeld());
  }

  /** Says whether a camera is running. Reporting runs while any camera is; a camera that stops lets go of what it held. */
  setCameraOn(on: boolean, slot: CameraSlot = "primary"): void {
    if (this.slotOn[slot] === on) return;
    this.slotOn[slot] = on;
    this.detector.setSlotRunning(slot, on, this.clock());
    const any = this.slotOn.primary || this.slotOn.secondary;
    if (any === this.on) {
      if (this.on) this.flush([], this.currentHeld());
      return;
    }
    this.on = any;
    if (!any) {
      this.detector.reset();
      this.lastHeld = [];
      if (this.reportedOn) this.send({ known: [], held: [], risen: [] });
      this.reportedOn = false;
    }
  }

  onFrame(frame: HandFrame, slot: CameraSlot = "primary"): void {
    if (!this.slotOn[slot]) return;
    const events = this.detector.update(slot, frame.captureMs, frame.hands);
    const risen = events.filter((event) => event.kind === "onset").map((event) => event.gestureId);
    const held = this.currentHeld();
    const changed = risen.length > 0 || held.join() !== this.lastHeld.join();
    if (changed || this.clock() - this.lastSentMs >= HEARTBEAT_MS) this.flush(risen, held);
  }

  private currentHeld(): string[] {
    return [...this.detector.states()].filter(([, state]) => state.held).map(([id]) => id);
  }

  private flush(risen: string[], held: string[]): void {
    this.lastSentMs = this.clock();
    this.lastHeld = held;
    this.reportedOn = true;
    this.send({ known: this.known, held, risen });
  }
}
