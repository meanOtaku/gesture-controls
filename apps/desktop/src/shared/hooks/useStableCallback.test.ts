import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useStableCallback } from "./useStableCallback";

describe("useStableCallback", () => {
  it("keeps one identity but calls the latest function", () => {
    const first = vi.fn(() => "first");
    const second = vi.fn(() => "second");
    const { result, rerender } = renderHook(({ fn }) => useStableCallback(fn), { initialProps: { fn: first } });
    const identity = result.current;
    expect(identity()).toBe("first");
    rerender({ fn: second });
    expect(result.current).toBe(identity);
    expect(identity()).toBe("second");
  });

  it("passes arguments through", () => {
    const { result } = renderHook(() => useStableCallback((a: number, b: number) => a + b));
    expect(result.current(2, 3)).toBe(5);
  });
});
