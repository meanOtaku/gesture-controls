import type { CameraSlot, TrackedHand } from "../camera/handTypes";
import type { GestureDefinition } from "./definition";
import { GestureDetector, type GestureEvent, type GestureState } from "./detector";

export type { CameraSlot };
/** `either`: a gesture is held when any running camera sees it. `both`: only when every running camera does. */
export type CombineMode = "either" | "both";

const SLOTS: CameraSlot[] = ["primary", "secondary"];

interface Merged {
  held: boolean;
  sinceMs: number | null;
}

/**
 * Runs the library's gestures on each camera on its own and merges only the decisions: nothing is lined up frame by frame.
 * Both cameras stamp frames on the same browser clock, and each detector already smooths its own flicker with the hold and
 * release times, so a merged gesture starts when the first camera confirms it (at that camera's start time) and ends when
 * the last one lets go. A slot that is not running is left out, so "both" does not wait for a camera that is off.
 */
export class CombinedGestureDetector {
  private detectors: Record<CameraSlot, GestureDetector>;
  private running: Record<CameraSlot, boolean> = { primary: true, secondary: false };
  private merged = new Map<string, Merged>();
  private counts = new Map<string, number>();
  private lastMs = 0;

  constructor(private definitions: GestureDefinition[], private mode: CombineMode = "either") {
    this.detectors = { primary: new GestureDetector(definitions), secondary: new GestureDetector(definitions) };
  }

  setDefinitions(definitions: GestureDefinition[]): void {
    this.definitions = definitions;
    for (const slot of SLOTS) this.detectors[slot].setDefinitions(definitions);
    const keep = new Set(definitions.map((definition) => definition.id));
    for (const id of [...this.merged.keys()]) if (!keep.has(id)) this.merged.delete(id);
  }

  setMode(mode: CombineMode): GestureEvent[] {
    this.mode = mode;
    return this.remerge([], this.lastMs);
  }

  /** Says whether a camera is running. A camera that stops lets go of what it held, which may end a merged gesture. */
  setSlotRunning(slot: CameraSlot, running: boolean, atMs: number): GestureEvent[] {
    if (this.running[slot] === running) return [];
    this.running[slot] = running;
    if (!running) this.detectors[slot].reset();
    return this.remerge([], Math.max(atMs, this.lastMs));
  }

  /** One frame from one camera. Returns the merged starts and ends it caused. */
  update(slot: CameraSlot, captureMs: number, hands: TrackedHand[]): GestureEvent[] {
    this.lastMs = Math.max(this.lastMs, captureMs);
    const own = this.detectors[slot].update(captureMs, hands);
    return this.remerge(own, captureMs);
  }

  states(): Map<string, GestureState> {
    return new Map(
      this.definitions.map((definition) => {
        const merged = this.merged.get(definition.id);
        return [definition.id, { held: merged?.held ?? false, sinceMs: merged?.held ? merged.sinceMs : null, count: this.counts.get(definition.id) ?? 0 }];
      }),
    );
  }

  reset(): void {
    for (const slot of SLOTS) this.detectors[slot].reset();
    this.merged.clear();
    this.counts.clear();
  }

  private remerge(own: GestureEvent[], atMs: number): GestureEvent[] {
    const events: GestureEvent[] = [];
    const live = SLOTS.filter((slot) => this.running[slot]);
    const states = live.map((slot) => this.detectors[slot].states());
    for (const definition of this.definitions) {
      const held = states.map((s) => s.get(definition.id)).filter((s) => s?.held);
      const sinces = held.map((s) => s!.sinceMs ?? atMs);
      const isHeld = live.length > 0 && (this.mode === "either" ? held.length > 0 : held.length === live.length);
      const sinceMs = isHeld ? (this.mode === "either" ? Math.min(...sinces) : Math.max(...sinces)) : null;
      const before = this.merged.get(definition.id) ?? { held: false, sinceMs: null };
      if (isHeld && !before.held) {
        this.counts.set(definition.id, (this.counts.get(definition.id) ?? 0) + 1);
        events.push({ gestureId: definition.id, kind: "onset", atMs: sinceMs! });
      } else if (!isHeld && before.held) {
        const endedAt = own.find((event) => event.gestureId === definition.id && event.kind === "release")?.atMs ?? atMs;
        events.push({ gestureId: definition.id, kind: "release", atMs: endedAt, heldMs: endedAt - (before.sinceMs ?? endedAt) });
      }
      this.merged.set(definition.id, { held: isHeld, sinceMs });
    }
    return events;
  }
}
