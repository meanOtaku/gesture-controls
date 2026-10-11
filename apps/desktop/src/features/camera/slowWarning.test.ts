import { describe, expect, it } from "vitest";
import { NOT_SLOW, SLOW_AFTER_MS, nextSlowState } from "./slowWarning";

describe("nextSlowState", () => {
  it("waits for the rate to stay low before warning", () => {
    let state = nextSlowState(NOT_SLOW, 12, 0);
    expect(state.slow).toBe(false);
    state = nextSlowState(state, 12, SLOW_AFTER_MS - 1);
    expect(state.slow).toBe(false);
    expect(nextSlowState(state, 12, SLOW_AFTER_MS).slow).toBe(true);
  });

  it("forgets a brief dip", () => {
    let state = nextSlowState(NOT_SLOW, 10, 0);
    state = nextSlowState(state, 25, 1000);
    expect(state).toEqual(NOT_SLOW);
    expect(nextSlowState(state, 10, 4000).slow).toBe(false); // the clock starts again
  });

  it("does not flicker around the limit: the warning stays until the rate is clearly back", () => {
    let state = nextSlowState(nextSlowState(NOT_SLOW, 12, 0), 12, SLOW_AFTER_MS);
    expect(state.slow).toBe(true);
    for (const fps of [15, 16, 14, 17, 15.5]) state = nextSlowState(state, fps, 10_000);
    expect(state.slow).toBe(true);
    expect(nextSlowState(state, 18, 11_000).slow).toBe(false);
  });

  it("says nothing when the rate is not measured", () => {
    expect(nextSlowState({ slow: true, since: 0 }, null, 5)).toEqual(NOT_SLOW);
    expect(nextSlowState({ slow: true, since: 0 }, 0, 5)).toEqual(NOT_SLOW);
  });
});
