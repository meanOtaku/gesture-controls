import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { ThresholdCard, type ThresholdSweep } from "./ThresholdCard";

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

// An hour with no gesture under way on the camera-timed recordings: 40, 30 and 20 false activations at 0.60, 0.65 and 0.70.
const estimated = { recordings: 1, starts: 30, caught: 28, repeats: 0, late: 0, falseActivations: 0, negativeSeconds: 600, falseActivationsPerHour: 0 };
const sweep: ThresholdSweep = {
  version: "v1",
  label: "pinch",
  threshold: 0.65,
  recordings: 3,
  budgetPerHour: 30,
  points: [0.6, 0.65, 0.7].map((threshold, i) => {
    const camera = { recordings: 2, starts: 100, caught: 60 - i * 10, repeats: 3 - i, late: 1, falseActivations: 40 - i * 10, negativeSeconds: 3600, falseActivationsPerHour: 40 - i * 10 };
    return { threshold, ...camera, cohort: "camera" as const, byLabelTiming: { camera, estimated } };
  }),
};

describe("the threshold card", () => {
  it("shows the trade-off per hour with no gesture under way against the budget, at the model's own threshold, then at another", async () => {
    invoke.mockResolvedValue(sweep);
    render(<ThresholdCard desktopAvailable models={[{ id: "v1", label: "pinch", state: "active", deployable: true, imported: false, modelSha256: null, createdAt: "", active: true }]} />);
    fireEvent.change(screen.getByLabelText("Model for the threshold"), { target: { value: "v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Show the trade-off" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "At 0.65: caught 50 of 100 starts (50%), with 30 false activations an hour with no gesture under way (within the 30 an hour budget); 2 repeats and 1 late. This is the model's own threshold.",
      ),
    );
    expect(screen.getByTestId("threshold-budget")).toBeInTheDocument();
    expect(screen.getByText("budget 30/h")).toBeInTheDocument();
    // Judged on the camera-timed recordings; the estimated ones shown apart.
    expect(screen.getByLabelText("Label timing")).toHaveTextContent("Judged on the 2 camera-timed recordings. Shown, not judged on: estimated from motion (1): caught 28 of 30 starts (93%), 0 false activations an hour");
    fireEvent.change(screen.getByLabelText("Threshold to look at"), { target: { value: "0.6" } });
    expect(screen.getByRole("status")).toHaveTextContent("At 0.60: caught 60 of 100 starts (60%), with 40 false activations an hour with no gesture under way (over the 30 an hour budget); 3 repeats and 1 late, against 50% and 30 at its own 0.65.");
    expect(invoke).toHaveBeenCalledWith("threshold_sweep", { versionId: "v1" });
  });
});
