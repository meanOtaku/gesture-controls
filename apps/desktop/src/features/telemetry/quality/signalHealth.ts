/**
 * How the watch's streams are doing right now: how many motion and pulse samples arrived over the last few seconds, how
 * long since the last of each, and how often the pulse sensor flagged its contact. Recording through a broken stream
 * wastes the session, so the Recorder shows this live and says plainly when something is wrong.
 */
export const HEALTH_WINDOW_MS = 5000;

export interface SignalHealthSnapshot {
  motionHz: number;
  pulseHz: number;
  /** Share of pulse samples over the window whose sensor flagged poor contact; null with no pulse samples. */
  pulseFlaggedShare: number | null;
  /** Null when none has arrived yet. */
  msSinceMotion: number | null;
  msSincePulse: number | null;
}

export class SignalHealthTracker {
  private motion: number[] = [];
  private pulse: { at: number; flagged: boolean }[] = [];

  noteMotion(nowMs: number): void {
    this.motion.push(nowMs);
    this.trim(nowMs);
  }

  notePulse(nowMs: number, flagged: boolean): void {
    this.pulse.push({ at: nowMs, flagged });
    this.trim(nowMs);
  }

  reset(): void {
    this.motion = [];
    this.pulse = [];
  }

  snapshot(nowMs: number): SignalHealthSnapshot {
    this.trim(nowMs);
    const seconds = HEALTH_WINDOW_MS / 1000;
    const flagged = this.pulse.filter((entry) => entry.flagged).length;
    return {
      motionHz: this.motion.length / seconds,
      pulseHz: this.pulse.length / seconds,
      pulseFlaggedShare: this.pulse.length > 0 ? flagged / this.pulse.length : null,
      msSinceMotion: this.motion.length > 0 ? nowMs - this.motion[this.motion.length - 1] : this.lastMotion === null ? null : nowMs - this.lastMotion,
      msSincePulse: this.pulse.length > 0 ? nowMs - this.pulse[this.pulse.length - 1].at : this.lastPulse === null ? null : nowMs - this.lastPulse,
    };
  }

  private lastMotion: number | null = null;
  private lastPulse: number | null = null;

  private trim(nowMs: number): void {
    if (this.motion.length > 0) this.lastMotion = this.motion[this.motion.length - 1];
    if (this.pulse.length > 0) this.lastPulse = this.pulse[this.pulse.length - 1].at;
    while (this.motion.length > 0 && nowMs - this.motion[0] > HEALTH_WINDOW_MS) this.motion.shift();
    while (this.pulse.length > 0 && nowMs - this.pulse[0].at > HEALTH_WINDOW_MS) this.pulse.shift();
  }
}

export type HealthLevel = "ok" | "warn" | "bad" | "off";

export interface HealthItem {
  key: "motion" | "pulse" | "contact";
  title: string;
  level: HealthLevel;
  text: string;
}

/** A stream this long silent has stopped. */
const STALE_MS = 1000;
/** The pulse sensor runs at 25 Hz; motion at the rate chosen in Settings (at least 25 Hz). */
const PULSE_LOW_HZ = 20;
const MOTION_LOW_HZ = 20;
const CONTACT_WARN = 0.1;
const CONTACT_BAD = 0.3;

/** Each stream's state in words, and how worried to be about it. */
export function assessHealth(health: SignalHealthSnapshot): HealthItem[] {
  const stream = (key: "motion" | "pulse", title: string, hz: number, since: number | null, low: number): HealthItem => {
    if (since === null) return { key, title, level: "off", text: "nothing yet" };
    if (since > STALE_MS) return { key, title, level: "bad", text: `stopped ${(since / 1000).toFixed(1)} s ago` };
    if (hz < low) return { key, title, level: "warn", text: `${hz.toFixed(0)} Hz, slower than it should be` };
    return { key, title, level: "ok", text: `${hz.toFixed(0)} Hz` };
  };
  const share = health.pulseFlaggedShare;
  const contact: HealthItem =
    share === null
      ? { key: "contact", title: "Pulse contact", level: "off", text: "no pulse samples" }
      : share > CONTACT_BAD
        ? { key: "contact", title: "Pulse contact", level: "bad", text: `flagged on ${Math.round(share * 100)}%: tighten the strap or move the watch up the wrist` }
        : share > CONTACT_WARN
          ? { key: "contact", title: "Pulse contact", level: "warn", text: `flagged on ${Math.round(share * 100)}%` }
          : { key: "contact", title: "Pulse contact", level: "ok", text: "good" };
  return [
    stream("motion", "Motion", health.motionHz, health.msSinceMotion, MOTION_LOW_HZ),
    stream("pulse", "Pulse", health.pulseHz, health.msSincePulse, PULSE_LOW_HZ),
    contact,
  ];
}
