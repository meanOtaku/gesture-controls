import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { guidedRunner } from "../recording/guidedRunner";
import { labelAt, planSteps, type GuidedPlan } from "../recording/guidedSession";
import { telemetryStore } from "../store/telemetryStore";
import { EverydayNoiseCard } from "./EverydayNoiseCard";

beforeEach(() => {
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
  it("records your normal routine by default, all of it everyday noise, with nothing to label", () => {
    render(<EverydayNoiseCard recording={false} watchConnected onStop={() => undefined} />);
    expect(screen.getByRole("radio", { name: /Active/ })).toBeChecked();
    expect(screen.getByLabelText("Minutes")).toHaveValue(10);
    const start = vi.spyOn(guidedRunner, "start").mockReturnValue(true);
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Start everyday noise session" }));
    const [plan, , source] = start.mock.calls[0];
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
