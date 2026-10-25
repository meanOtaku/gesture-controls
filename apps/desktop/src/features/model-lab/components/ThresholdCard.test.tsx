import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
import { ThresholdCard, type ThresholdSweep } from "./ThresholdCard";

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const sweep: ThresholdSweep = {
  version: "v1",
  label: "pinch",
  threshold: 0.65,
  recordings: 2,
  points: [0.6, 0.65, 0.7].map((threshold, i) => ({ threshold, starts: 100, caught: 60 - i * 10, falseActivations: 30 - i * 10, minutes: 10 })),
};

describe("the threshold card", () => {
  it("shows the trade-off at the model's own threshold, then at another", async () => {
    invoke.mockResolvedValue(sweep);
    render(<ThresholdCard desktopAvailable models={[{ id: "v1", label: "pinch", state: "active", deployable: true, imported: false, modelSha256: null, createdAt: "", active: true }]} />);
    fireEvent.change(screen.getByLabelText("Model for the threshold"), { target: { value: "v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Show the trade-off" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("At 0.65: caught 50 of 100 starts (50%), with 2.0 false alarms a minute. This is the model's own threshold."));
    fireEvent.change(screen.getByLabelText("Threshold to look at"), { target: { value: "0.6" } });
    expect(screen.getByRole("status")).toHaveTextContent("At 0.60: caught 60 of 100 starts (60%), with 3.0 false alarms a minute, against 50% and 2.0 at its own 0.65.");
    expect(invoke).toHaveBeenCalledWith("threshold_sweep", { versionId: "v1" });
  });
});
