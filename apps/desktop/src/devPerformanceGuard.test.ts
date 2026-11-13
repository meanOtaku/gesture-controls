import { describe, expect, it, vi } from "vitest";
import { installDevPerformanceGuard } from "./devPerformanceGuard";

const fakePerformance = () => {
  const measure = vi.fn(() => ({}) as PerformanceMeasure);
  return { target: { measure } as unknown as Performance, measure };
};

describe("the development performance guard", () => {
  it("drops React's per-render Performance Track entries", () => {
    const { target, measure } = fakePerformance();
    installDevPerformanceGuard(target);
    target.measure("​AppNav", { start: 1, end: 2, detail: { devtools: { track: "Components ⚛" } } });
    expect(measure).not.toHaveBeenCalled();
  });

  it("lets every other measure through", () => {
    const { target, measure } = fakePerformance();
    installDevPerformanceGuard(target);
    target.measure("load", { start: 1, end: 2 });
    target.measure("between", "a", "b");
    target.measure("with detail", { start: 1, detail: { note: "mine" } });
    expect(measure).toHaveBeenCalledTimes(3);
  });
});
