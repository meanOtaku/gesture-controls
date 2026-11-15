import { describe, expect, it } from "vitest";

import { KNOB_PULSE_EVERY_MS, KNOB_PULSE_MS, startKnobBuzz } from "./knobBuzz";

/** A clock run by hand: the timers wait until `advance` passes their time. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; run: () => void; id: number }[] = [];
  let next = 0;
  return {
    setTimer: (run: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: now + ms, run, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > end) break;
        timers.shift();
        now = due.at;
        due.run();
      }
      now = end;
    },
    get now() {
      return now;
    },
  };
}

describe("startKnobBuzz", () => {
  it("waits a quiet gap, then buzzes 20 ms every 1/8 s for the burst, then is quiet again", () => {
    const clock = fakeClock();
    const buzzes: { at: number; ms: number }[] = [];
    // random 0.5: gaps of 8 s, bursts of 2 s (16 pulses).
    const stop = startKnobBuzz({ random: () => 0.5, buzz: (ms) => buzzes.push({ at: clock.now, ms }), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    clock.advance(7_999);
    expect(buzzes).toEqual([]);
    clock.advance(1 + 15 * KNOB_PULSE_EVERY_MS);
    expect(buzzes).toHaveLength(16);
    expect(buzzes.every((buzz) => buzz.ms === KNOB_PULSE_MS)).toBe(true);
    expect(buzzes[1].at - buzzes[0].at).toBe(KNOB_PULSE_EVERY_MS);
    clock.advance(7_999);
    expect(buzzes).toHaveLength(16);
    clock.advance(1);
    expect(buzzes).toHaveLength(17);
    stop();
  });

  it("never buzzes again once stopped", () => {
    const clock = fakeClock();
    let count = 0;
    const stop = startKnobBuzz({ random: () => 0, buzz: () => count++, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    clock.advance(4_000 + 3 * KNOB_PULSE_EVERY_MS);
    expect(count).toBe(4);
    stop();
    clock.advance(60_000);
    expect(count).toBe(4);
  });
});
