import { expect, it } from "vitest";
import { analyse, type MeasureSample } from "./calibration";
import { MEASURE_NAMES } from "./definition";

const frames = (count: number, offset: number): MeasureSample[] =>
  Array.from({ length: count }, (_, i) => Object.fromEntries(MEASURE_NAMES.map((name, k) =>
    [name, Math.round(((Math.sin(i * 1.7 + k * 3.1 + offset) + 1) / 2) * 10_000) / 10_000])));

it("keeps warmed median calibration below 100 ms on an otherwise idle host", () => {
  const positive = frames(900, 0);
  const negative = frames(900, 1);
  const other = [{ name: "Other", samples: frames(300, 2) }];
  const run = () => analyse(positive, negative, other);
  for (let i = 0; i < 5; i++) run();
  const timings = Array.from({ length: 21 }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  console.info(`Calibration: median ${timings[10].toFixed(2)} ms, p95 ${timings[19].toFixed(2)} ms`);
  expect(timings[10]).toBeLessThan(100);
});
