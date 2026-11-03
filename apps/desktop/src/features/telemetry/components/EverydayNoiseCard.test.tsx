import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { guidedRunner } from "../recording/guidedRunner";
import { labelAt, planSteps } from "../recording/guidedSession";
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

describe("EverydayNoiseCard", () => {
  it("records a stretch of your routine, all of it everyday noise, with nothing to label", () => {
    render(<EverydayNoiseCard recording={false} watchConnected onStop={() => undefined} />);
    expect(screen.getByLabelText("Minutes")).toHaveValue(10);
    expect(screen.queryByRole("combobox")).toBeNull();
    const start = vi.spyOn(guidedRunner, "start").mockReturnValue(true);
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Start everyday noise session" }));
    const [plan, , source] = start.mock.calls[0];
    expect(source).toBe("noise");
    expect(plan).toMatchObject({ label: "", cues: 0, everydayLabel: "everyday_noise" });
    expect(plan.activities).toEqual([{ activity: "Go about your routine. No gestures.", seconds: 300 }]);
    // After the lead-in, every moment of it is everyday noise.
    const steps = planSteps(plan);
    const routine = steps.find((step) => step.kind === "activity")!;
    expect([routine.atMs + 1, routine.atMs + 150_000, routine.atMs + 299_000].map((ms) => labelAt(steps, ms))).toEqual(["everyday_noise", "everyday_noise", "everyday_noise"]);
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
