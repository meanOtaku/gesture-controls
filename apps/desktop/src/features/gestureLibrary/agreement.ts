/**
 * How well a deployed model agrees with the camera, live. The camera's gesture is taken as the truth (it sees the hand
 * directly); the model sees only the watch. Both are timed on the browser's clock: the camera by when its picture was
 * taken, the model by when its detection arrived, so the delay measured includes the time the detection took to arrive.
 *
 * A camera hold counts as found when the model starts a detection of the same label from a moment before the hold
 * began to a couple of seconds after. A model detection counts as a false alarm only when the camera was watching a hand
 * and no hold was going on; with no hand in view the camera cannot say, so those detections are left out, not counted
 * either way.
 */

/** A detection this much before the camera's start still counts (the camera confirms a pose a moment after it began). */
export const LEAD_MS = 300;
/** A detection this long after the camera's start still counts as the same gesture. */
export const LAG_MS = 2000;
const MAX_KEPT = 2000;

export interface LabelAgreement {
  /** Holds the camera saw whose window has closed, so they can be judged. */
  holds: number;
  found: number;
  missed: number;
  /** Model detections with the camera watching a hand and no hold going on. */
  falseAlarms: number;
  /** Detections with no hand in view, which the camera cannot judge. */
  unverified: number;
  /** Middle delay from the camera's start to the model's detection, for found holds. */
  medianDelayMs: number | null;
}

interface Hold {
  startMs: number;
  endMs: number | null;
}

export class AgreementTracker {
  private holds = new Map<string, Hold[]>();
  private detections = new Map<string, number[]>();
  private view: { ms: number; seen: boolean }[] = [];

  /** Whether the camera can see a hand, as it changes. */
  setHandInView(atMs: number, seen: boolean): void {
    const last = this.view[this.view.length - 1];
    if (last && last.seen === seen) return;
    this.view.push({ ms: atMs, seen });
    if (this.view.length > MAX_KEPT) this.view.shift();
  }

  private seenAt(ms: number): boolean {
    let seen = false;
    for (const change of this.view) {
      if (change.ms > ms) break;
      seen = change.seen;
    }
    return seen;
  }

  cameraOnset(label: string, atMs: number): void {
    this.push(this.holds, label, { startMs: atMs, endMs: null });
  }

  cameraRelease(label: string, atMs: number): void {
    const list = this.holds.get(label);
    const open = list?.[list.length - 1];
    if (open && open.endMs === null) open.endMs = atMs;
  }

  modelDetected(label: string, atMs: number): void {
    this.push(this.detections, label, atMs);
  }

  private push<T>(map: Map<string, T[]>, label: string, item: T): void {
    const list = map.get(label) ?? [];
    list.push(item);
    if (list.length > MAX_KEPT) list.shift();
    map.set(label, list);
  }

  labels(): string[] {
    return [...new Set([...this.holds.keys(), ...this.detections.keys()])];
  }

  summarize(label: string, nowMs: number): LabelAgreement {
    const holds = this.holds.get(label) ?? [];
    const detections = [...(this.detections.get(label) ?? [])].sort((a, b) => a - b);
    const used = new Set<number>();
    const delays: number[] = [];
    let judged = 0;
    let found = 0;
    for (const hold of holds) {
      if (nowMs - hold.startMs < LAG_MS) continue; // the model may still answer
      judged += 1;
      const index = detections.findIndex((at, i) => !used.has(i) && at >= hold.startMs - LEAD_MS && at <= hold.startMs + LAG_MS);
      if (index >= 0) {
        used.add(index);
        found += 1;
        delays.push(detections[index] - hold.startMs);
      }
    }
    let falseAlarms = 0;
    let unverified = 0;
    detections.forEach((at, i) => {
      if (used.has(i)) return;
      if (holds.some((hold) => at >= hold.startMs - LEAD_MS && at <= (hold.endMs ?? Infinity) + LAG_MS)) return; // a repeat during a hold
      if (nowMs - at < 0) return;
      if (this.seenAt(at)) falseAlarms += 1;
      else unverified += 1;
    });
    delays.sort((a, b) => a - b);
    const mid = delays.length === 0 ? null : delays.length % 2 ? delays[(delays.length - 1) / 2] : (delays[delays.length / 2 - 1] + delays[delays.length / 2]) / 2;
    return { holds: judged, found, missed: judged - found, falseAlarms, unverified, medianDelayMs: mid };
  }

  reset(): void {
    this.holds.clear();
    this.detections.clear();
    this.view = [];
  }
}
