import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLASH_MS, useFlash } from "./useFlash";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useFlash", () => {
  it("does not flash for the count the page opened with", () => {
    const { result } = renderHook(({ count }) => useFlash(count), { initialProps: { count: 5 } });
    expect(result.current).toBe(false);
  });

  it("lights when the count goes up and goes dark after a moment", () => {
    const { result, rerender } = renderHook(({ count }) => useFlash(count), { initialProps: { count: 0 } });
    rerender({ count: 1 });
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(FLASH_MS + 10); });
    expect(result.current).toBe(false);
  });

  it("stays lit longer when it is recognised again before it fades", () => {
    const { result, rerender } = renderHook(({ count }) => useFlash(count), { initialProps: { count: 0 } });
    rerender({ count: 1 });
    act(() => { vi.advanceTimersByTime(FLASH_MS - 100); });
    rerender({ count: 2 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(FLASH_MS); });
    expect(result.current).toBe(false);
  });
});
