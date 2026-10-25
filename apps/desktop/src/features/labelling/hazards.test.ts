import { describe, expect, it } from "vitest";
import { hazardsIn } from "./hazards";

const stream = (timesMs: number[], columns: Record<string, (number | null)[]>) => ({ timesMs, columns: Object.entries(columns).map(([name, values]) => ({ name, values })) });

describe("suspect data", () => {
  it("finds stalls, clock jumps, a flat pulse, flagged contact and a stuck sensor", () => {
    const t = Array.from({ length: 100 }, (_, i) => i * 40); // 25 Hz, 0 to 3.96 s
    const green = t.map((_, i) => (i >= 20 && i < 50 ? 103 : 100 + (i % 7))); // flat 0.8 to 1.96 s, inside its usual range
    const contact = t.map((_, i) => (i >= 60 && i < 80 ? 1 : 0)); // flagged 2.4 to 3.16 s
    const ppg = stream([...t.slice(0, 90), ...t.slice(90).map((ms) => ms + 1000)], { ppg_green: green, contact_quality: contact }); // a 1 s stall at 3.56 s
    const mt = [0, 20, 40, 30, 60, ...Array.from({ length: 20 }, (_, i) => 80 + i * 20)];
    const accel = mt.map((_, i) => (i >= 5 && i < 17 ? 78.4 : Math.sin(i))); // stuck at its highest for 12 samples
    const hazards = hazardsIn(ppg, stream(mt, { accel_x: accel }));
    expect(hazards.map((h) => h.text)).toEqual([
      "The motion clock jumped back 10 ms",
      "accel_x is stuck at its highest value: out of the sensor's range",
      "The pulse signal is flat: the sensor was not measuring",
      "The pulse sensor flagged poor contact",
      "Pulse stopped for 1.0 s",
    ]);
    expect(hazards[2]).toMatchObject({ startMs: 840, endMs: 1960 });
  });

  it("finds nothing in clean data", () => {
    const t = Array.from({ length: 50 }, (_, i) => i * 40);
    expect(hazardsIn(stream(t, { ppg_green: t.map((_, i) => 100 + (i % 5)), contact_quality: t.map(() => 0) }), stream(t, { accel_x: t.map((_, i) => Math.sin(i)) }))).toEqual([]);
  });
});
