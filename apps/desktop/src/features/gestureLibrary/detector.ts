import { physicalHand, type TrackedHand } from "../camera/handTypes";
import { measureHand } from "../camera/landmarkMath";
import { type Condition, type GestureDefinition, measureValue } from "./definition";

export interface GestureEvent {
  gestureId: string;
  kind: "onset" | "release";
  /** When it began or ended, on the browser clock (the camera frame times). An onset is stamped when the pose began, not when it was confirmed. */
  atMs: number;
  /** For a release: how long it was held. */
  heldMs?: number;
}

export interface GestureState {
  held: boolean;
  /** When the current hold began. */
  sinceMs: number | null;
  /** How many times it has started. */
  count: number;
}

const passes = (condition: Condition, value: number | null, threshold: number): boolean =>
  value !== null && (condition.direction === "below" ? value < threshold : value > threshold);

/** Does one hand satisfy the definition's conditions, using either the start or the end thresholds? */
export function handMatches(definition: GestureDefinition, hand: TrackedHand, stage: "enter" | "exit"): boolean {
  if (definition.hand !== "either" && physicalHand(hand).toLowerCase() !== definition.hand) return false;
  const measures = measureHand(hand);
  if (!measures || definition.conditions.length === 0) return false;
  return definition.conditions.every((condition) => passes(condition, measureValue(measures, condition.measure), condition[stage]));
}

type Phase = { kind: "idle" } | { kind: "candidate"; sinceMs: number } | { kind: "held"; sinceMs: number; lostSinceMs: number | null };

/**
 * Follows a stream of camera frames and says when each gesture starts and ends.
 *
 * A gesture starts when its pose has held for `minHoldMs` (stamped with when it began, so the time is true). It then
 * stays on while the looser end thresholds hold, and ends once the pose has been lost for `releaseGraceMs` (stamped with
 * when it was first lost). The two thresholds and the grace time are what stop a wobbling hand flickering on and off.
 */
export class GestureDetector {
  private phases = new Map<string, Phase>();
  private counts = new Map<string, number>();

  constructor(private definitions: GestureDefinition[]) {}

  setDefinitions(definitions: GestureDefinition[]): void {
    const keep = new Set(definitions.map((definition) => definition.id));
    for (const id of this.phases.keys()) if (!keep.has(id)) this.phases.delete(id);
    this.definitions = definitions;
  }

  states(): Map<string, GestureState> {
    return new Map(
      this.definitions.map((definition) => {
        const phase = this.phases.get(definition.id) ?? { kind: "idle" as const };
        return [definition.id, { held: phase.kind === "held", sinceMs: phase.kind === "held" ? phase.sinceMs : null, count: this.counts.get(definition.id) ?? 0 }];
      }),
    );
  }

  /** Feed one frame. Returns the starts and ends it caused. */
  update(captureMs: number, hands: TrackedHand[]): GestureEvent[] {
    const events: GestureEvent[] = [];
    for (const definition of this.definitions) {
      const phase = this.phases.get(definition.id) ?? { kind: "idle" as const };
      const starting = hands.some((hand) => handMatches(definition, hand, "enter"));
      const staying = hands.some((hand) => handMatches(definition, hand, "exit"));
      if (phase.kind === "idle") {
        if (starting) this.phases.set(definition.id, { kind: "candidate", sinceMs: captureMs });
        else continue;
      }
      const current = this.phases.get(definition.id)!;
      if (current.kind === "candidate") {
        if (!starting) {
          this.phases.set(definition.id, { kind: "idle" });
        } else if (captureMs - current.sinceMs >= definition.minHoldMs) {
          this.phases.set(definition.id, { kind: "held", sinceMs: current.sinceMs, lostSinceMs: null });
          this.counts.set(definition.id, (this.counts.get(definition.id) ?? 0) + 1);
          events.push({ gestureId: definition.id, kind: "onset", atMs: current.sinceMs });
        }
      } else if (current.kind === "held") {
        if (staying) {
          if (current.lostSinceMs !== null) this.phases.set(definition.id, { ...current, lostSinceMs: null });
        } else {
          const lostSince = current.lostSinceMs ?? captureMs;
          if (captureMs - lostSince >= definition.releaseGraceMs) {
            this.phases.set(definition.id, { kind: "idle" });
            events.push({ gestureId: definition.id, kind: "release", atMs: lostSince, heldMs: lostSince - current.sinceMs });
          } else if (current.lostSinceMs === null) {
            this.phases.set(definition.id, { ...current, lostSinceMs: lostSince });
          }
        }
      }
    }
    return events;
  }

  reset(): void {
    this.phases.clear();
    this.counts.clear();
  }
}
