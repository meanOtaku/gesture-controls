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
    fireEvent.change(screen.getByLabelText("Threshold to look at"), { target: { value: "0" } }); // the first point, 0.60
    expect(screen.getByRole("status")).toHaveTextContent("At 0.60: caught 60 of 100 starts (60%), with 40 false activations an hour with no gesture under way (over the 30 an hour budget); 3 repeats and 1 late, against 50% and 30 at its own 0.65.");
    expect(invoke).toHaveBeenCalledWith("threshold_sweep", { versionId: "v1" });
  });

  const trained = { id: "v1", label: "pinch", state: "active" as const, deployable: true, imported: false, modelSha256: null, createdAt: "", active: true, activation: 0.65, release: 0.5 };

  it("uses a chosen threshold within the budget at once, and says so", async () => {
    invoke.mockImplementation(async (command: string) => (command === "threshold_sweep" ? sweep : undefined));
    render(<ThresholdCard desktopAvailable models={[trained]} />);
    fireEvent.change(screen.getByLabelText("Model for the threshold"), { target: { value: "v1" } });
    expect(screen.getByLabelText("Current threshold")).toHaveTextContent("It runs at 0.65 and a detection ends below 0.50.");
    fireEvent.click(screen.getByRole("button", { name: "Show the trade-off" }));
    await screen.findByLabelText("Threshold to look at");
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull(); // its own threshold: nothing to change
    fireEvent.change(screen.getByLabelText("Threshold to look at"), { target: { value: "2" } }); // 0.70
    fireEvent.click(screen.getByRole("button", { name: "Use 0.70" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_label_model_threshold", { id: "v1", activation: 0.7 }));
    expect(await screen.findByText("v1 now runs at 0.70, from now on.")).toBeInTheDocument();
  });

  it("asks again before using a threshold over the budget", async () => {
    invoke.mockImplementation(async (command: string) => (command === "threshold_sweep" ? sweep : undefined));
    render(<ThresholdCard desktopAvailable models={[trained]} />);
    fireEvent.change(screen.getByLabelText("Model for the threshold"), { target: { value: "v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Show the trade-off" }));
    fireEvent.change(await screen.findByLabelText("Threshold to look at"), { target: { value: "0" } }); // 0.60, 40 an hour
    fireEvent.click(screen.getByRole("button", { name: "Use 0.60" }));
    expect(invoke).not.toHaveBeenCalledWith("set_label_model_threshold", expect.anything());
    expect(screen.getByText(/more often than the budget allows/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use 0.60 anyway" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_label_model_threshold", { id: "v1", activation: 0.6 }));
  });

  it("sets an imported model's threshold by number, with no curve, and shows its last change", async () => {
    invoke.mockResolvedValue(undefined);
    const imported = { ...trained, id: "imp", imported: true, activation: 0.95, release: 0.8,
      thresholdChanges: [{ fromActivation: 0.7, fromRelease: 0.55, toActivation: 0.95, toRelease: 0.8, at: "2026-11-09T10:00:00Z" }] };
    render(<ThresholdCard desktopAvailable models={[imported]} />);
    fireEvent.change(screen.getByLabelText("Model for the threshold"), { target: { value: "imp" } });
    expect(screen.queryByRole("button", { name: "Show the trade-off" })).toBeNull();
    expect(screen.getByLabelText("Current threshold")).toHaveTextContent(/Changed from 0\.70 to 0\.95 on /);
    fireEvent.change(screen.getByLabelText("New threshold"), { target: { value: "1.5" } });
    expect(screen.getByText("Enter a number above 0 and at most 1.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this threshold" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("New threshold"), { target: { value: "0.9" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this threshold" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_label_model_threshold", { id: "imp", activation: 0.9 }));
  });
});
