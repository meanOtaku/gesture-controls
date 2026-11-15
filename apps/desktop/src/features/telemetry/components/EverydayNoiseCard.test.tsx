import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { guidedRunner } from "../recording/guidedRunner";
import { labelAt, planSteps, type GuidedPlan } from "../recording/guidedSession";
import { telemetryStore } from "../store/telemetryStore";
import { EverydayNoiseCard } from "./EverydayNoiseCard";

const knob = vi.hoisted(() => ({ stop: vi.fn(), start: vi.fn() }));
vi.mock("../recording/knobBuzz", () => ({ startKnobBuzz: knob.start }));

beforeEach(() => {
  knob.stop.mockReset();
  knob.start.mockReset().mockReturnValue(knob.stop);
  localStorage.clear();
  telemetryStore.reset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The label on throughout the routine, after the lead-in. */
function labelsThroughout(plan: GuidedPlan): (string | null)[] {
  const steps = planSteps(plan);
  const routine = steps.find((step) => step.kind === "activity")!;
  return [routine.atMs + 1, routine.atMs + routine.durationMs / 2, routine.atMs + routine.durationMs - 1].map((ms) => labelAt(steps, ms));
}

describe("EverydayNoiseCard", () => {
  it("buzzes the watch like the volume knob only when asked, until the session ends, and says so in its details", () => {
    // The card's own listener is the last one subscribed; React's are left alone, so nothing is drawn running.
    const listeners: (() => void)[] = [];
    let running = false;
    vi.spyOn(guidedRunner, "subscribe").mockImplementation((next) => {
      listeners.push(next);
      return () => undefined;
    });
    vi.spyOn(guidedRunner, "snapshot").mockImplementation(() => (running ? ({ source: "noise" } as ReturnType<typeof guidedRunner.snapshot>) : null));
    const start = vi.spyOn(guidedRunner, "start").mockImplementation(() => {
      expect(telemetryStore.getSessionContext().activity).toBe("Everyday noise: active, with knob-like buzzes");
      return true;
    });
    render(<EverydayNoiseCard recording={false} watchConnected onStop={() => undefined} />);
    const box = screen.getByRole("checkbox", { name: "Buzz the watch like the volume knob" });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(JSON.parse(localStorage.getItem("recorder.noiseSession")!).knobBuzz).toBe(true);
    cleanup();
    render(<EverydayNoiseCard recording={false} watchConnected onStop={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Start everyday noise session" }));
    expect(start).toHaveBeenCalled();
    expect(knob.start).toHaveBeenCalledTimes(1);
    const listener = listeners[listeners.length - 1];
    running = true;
    listener();
    expect(knob.stop).not.toHaveBeenCalled();
    running = false;
    listener();
    expect(knob.stop).toHaveBeenCalledTimes(1);
  });

  it("records your normal routine by default, all of it everyday noise, with nothing to label", () => {
    render(<EverydayNoiseCard recording={false} watchConnected onStop={() => undefined} />);
    expect(screen.getByRole("radio", { name: /Active/ })).toBeChecked();
    expect(screen.getByLabelText("Minutes")).toHaveValue(10);
    const start = vi.spyOn(guidedRunner, "start").mockReturnValue(true);
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Start everyday noise session" }));
    const [plan, , source] = start.mock.calls[0];
    expect(knob.start).not.toHaveBeenCalled();
    expect(source).toBe("noise");
    expect(plan).toMatchObject({ label: "", cues: 0, activities: [{ seconds: 300 }] });
    expect(labelsThroughout(plan)).toEqual(["everyday_noise", "everyday_noise", "everyday_noise"]);
  });

  it("labels the hand held still as still, and the hand on a support as supported, flat or angled in its details", () => {
    telemetryStore.setSessionContext({ wrist: "left", activity: "typing" });
    const start = vi.spyOn(guidedRunner, "start").mockImplementation(() => {
      // The recording takes its details as it starts.
      expect(telemetryStore.getSessionContext()).toEqual({ wrist: "left", activity: "Everyday noise: hand on a support, angled" });
      return true;
    });
    render(<EverydayNoiseCard recording={false} watchConnected onStop={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: /Still/ }));
    expect(screen.getByLabelText("Minutes")).toHaveValue(3);
    expect(screen.queryByRole("radio", { name: "Angled" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /On a support/ }));
    expect(screen.getByLabelText("Minutes")).toHaveValue(5);
    fireEvent.click(screen.getByRole("radio", { name: "Angled" }));
    fireEvent.click(screen.getByRole("button", { name: "Start everyday noise session" }));
    expect(labelsThroughout(start.mock.calls[0][0])).toEqual(["supported", "supported", "supported"]);
    // Yours are back for the next recording.
    expect(telemetryStore.getSessionContext()).toEqual({ wrist: "left", activity: "typing" });
  });

  it("keeps it within what a recording holds, and waits for the watch", () => {
    const { rerender } = render(<EverydayNoiseCard recording={false} watchConnected onStop={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "45" } });
    expect(screen.getByText("Record 1 to 30 minutes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start everyday noise session" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "10" } });
    rerender(<EverydayNoiseCard recording={false} watchConnected={false} onStop={() => undefined} />);
    expect(screen.getByText("Connect the watch (Watch page) first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start everyday noise session" })).toBeDisabled();
  });
});
