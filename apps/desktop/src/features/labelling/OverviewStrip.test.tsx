import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewStrip } from "./OverviewStrip";

afterEach(cleanup);

describe("the overview strip", () => {
  it("looks where you click, keeping the zoom, and steps along with the arrow keys", () => {
    const onView = vi.fn();
    render(<OverviewStrip durationMs={60_000} recorded={[]} byHand={[]} marks={[]} view={{ startMs: 0, endMs: 10_000 }} colorOf={() => "#fff"} onView={onView} />);
    const strip = screen.getByRole("slider", { name: "Whole recording" });
    strip.getBoundingClientRect = () => ({ left: 0, width: 600, top: 0, right: 600, bottom: 30, height: 30, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(strip, { button: 0, clientX: 300, pointerId: 1 });
    expect(onView).toHaveBeenLastCalledWith({ startMs: 25_000, endMs: 35_000 });
    // Near the end, the view stops at the end.
    fireEvent.pointerMove(strip, { clientX: 595, pointerId: 1 });
    expect(onView).toHaveBeenLastCalledWith({ startMs: 50_000, endMs: 60_000 });
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(onView).toHaveBeenLastCalledWith({ startMs: 5000, endMs: 15_000 });
  });
});
