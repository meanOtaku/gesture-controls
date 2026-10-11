import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrainingRangeBackfill } from "./TrainingRangeBackfill";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

let missing: string[] = [];
beforeEach(() => {
  invokeMock.mockReset();
  missing = ["pinch-a", "pinch-b"];
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "list_models_without_range") return missing;
    if (command === "backfill_model_ranges") {
      missing = ["pinch-b"];
      return [
        { modelId: "pinch-a", outcome: "added", message: "recorded the range of 3 inputs from 589 training windows" },
        { modelId: "pinch-b", outcome: "skipped", message: "recording x has changed since this model was trained" },
      ];
    }
    return undefined;
  });
});
afterEach(cleanup);

describe("TrainingRangeBackfill", () => {
  it("says nothing when every trained model has a range", async () => {
    missing = [];
    const { container } = render(<TrainingRangeBackfill desktopAvailable refreshKey="" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("list_models_without_range"));
    expect(container).toBeEmptyDOMElement();
  });

  it("offers to work the ranges out, then says what happened to each model and what is still missing", async () => {
    render(<TrainingRangeBackfill desktopAvailable refreshKey="" />);
    expect(await screen.findByText(/2 trained models have no recorded training range/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Work out their ranges" }));
    const results = await screen.findByRole("list", { name: "Results" });
    expect(within(results).getByText(/pinch-a/).closest("li")).toHaveTextContent("Done. recorded the range of 3 inputs");
    expect(within(results).getByText(/pinch-b/).closest("li")).toHaveTextContent("Left as it was. recording x has changed");
    expect(await screen.findByText(/1 trained model has no recorded training range/)).toBeInTheDocument();
  });

  it("shows why it could not even start", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_models_without_range") return ["pinch-a"];
      throw "the trainer was not found, so ranges cannot be worked out here";
    });
    render(<TrainingRangeBackfill desktopAvailable refreshKey="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Work out their ranges" }));
    expect(await screen.findByText(/the trainer was not found/)).toBeInTheDocument();
  });
});
