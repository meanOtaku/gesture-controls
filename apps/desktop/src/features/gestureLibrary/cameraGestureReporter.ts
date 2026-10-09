import type { HandFrame } from "../camera/handTypes";
import type { GestureDefinition } from "./definition";
import { GestureDetector } from "./detector";

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
  private detector = new GestureDetector([]);
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

  setCameraOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (!on) {
      this.detector.reset();
      this.lastHeld = [];
      if (this.reportedOn) this.send({ known: [], held: [], risen: [] });
      this.reportedOn = false;
    }
  }

  onFrame(frame: HandFrame): void {
    if (!this.on) return;
    const events = this.detector.update(frame.captureMs, frame.hands);
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
