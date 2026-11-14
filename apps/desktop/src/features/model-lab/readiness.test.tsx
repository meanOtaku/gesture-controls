import { render, screen } from "@testing-library/react";
import { describe as group, expect, it } from "vitest";
import { ReadinessLightView } from "./components/ReadinessLight";
import { describe, overall, secondsLeft, type ReadinessView } from "./readiness";

const view = (label: string, state: ReadinessView["state"], readyInMs: number | null = null): ReadinessView => ({ label, state, readyInMs });

group("readiness", () => {
  it("shows the least ready model, ready when the last countdown ends", () => {
    expect(overall([], 0)).toBeNull();
    expect(overall([view("pinch_in", "ready"), view("pinch_out", "ready")], 0)).toEqual({ state: "ready", readyAt: null });
    expect(overall([view("pinch_in", "settling", 400), view("pinch_out", "gap", 9_000)], 1_000)).toEqual({ state: "gap", readyAt: 10_000 });
    expect(overall([view("pinch_in", "ready"), view("pinch_out", "moving", 900)], 1_000)).toEqual({ state: "moving", readyAt: 1_900 });
    expect(overall([view("pinch_in", "stale")], 0)).toEqual({ state: "stale", readyAt: null });
  });

  it("counts down in tenths through a short wait and in seconds through a long one", () => {
    expect(secondsLeft(1_640, 1_000)).toEqual({ value: 0.7, digits: 1 });
    expect(secondsLeft(9_200, 1_000)).toEqual({ value: 9, digits: 0 });
    expect(secondsLeft(500, 1_000)).toEqual({ value: 0, digits: 1 });
  });

  it("says what to do in a few words", () => {
    expect(describe("ready")).toMatchObject({ title: "Ready to pinch", tone: "ok" });
    expect(describe("settling")).toMatchObject({ title: "Hold still", tone: "wait" });
    expect(describe("gap")).toMatchObject({ title: "Signal dropped", tone: "off", countdown: "back in " });
  });

  it("renders the state with its countdown", () => {
    render(<ReadinessLightView readiness={{ state: "gap", readyAt: 9_000 }} now={1_000} />);
    const light = screen.getByRole("status", { name: "Gesture models: Signal dropped" });
    expect(light).toHaveTextContent("Signal dropped · back in 8 s");
    expect(light).toHaveAttribute("data-tone", "off");
  });
});
