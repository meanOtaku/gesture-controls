import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayPanel } from "./ReplayPanel";
import type { DatasetSummary, ReplayReport } from "../types";

afterEach(() => cleanup());

const DATASET: DatasetSummary = {
  id: "dataset-a",
  originalFilename: "session1.csv",
  importedAt: "2026-08-31T01:00:00Z",
  label: "pinch_start",
  rowCount: 120,
};

const REPORT: ReplayReport = {
  model_sha256: "abc123",
  window_count: 10,
  matched_count: 8,
  accuracy: 0.8,
  predicted_counts: { pinch_start: 4, negative: 6 },
  outcomes: [
    { index: 0, session_id: "s1", timestamp_ns: 0, expected: "pinch_start", predicted: "pinch_start", matched: true, confidence: 0.9 },
  ],
  outcomes_truncated: false,
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof ReplayPanel>> = {}) {
  const props: React.ComponentProps<typeof ReplayPanel> = {
    deployableModelIds: ["model-a"],
    datasets: [DATASET],
    onReplay: vi.fn().mockResolvedValue(REPORT),
    ...overrides,
  };
  render(<ReplayPanel {...props} />);
  return props;
}

describe("ReplayPanel", () => {
  it("exposes an accessible Replay region", () => {
    renderPanel();
    expect(screen.getByRole("region", { name: "Replay" })).toBeInTheDocument();
  });

  it("explains when no deployable model exists", () => {
    renderPanel({ deployableModelIds: [] });
    expect(screen.getByText(/no deployable models yet/i)).toBeInTheDocument();
  });

  it("disables Run replay until a model and dataset are selected", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Run replay" })).toBeDisabled();

    fireEvent.change(screen.getByRole("combobox", { name: "Replay model" }), { target: { value: "model-a" } });
    expect(screen.getByRole("button", { name: "Run replay" })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Run replay" })).toBeEnabled();
  });

  it("runs replay with selected model, datasets, and max outcomes", async () => {
    const onReplay = vi.fn().mockResolvedValue(REPORT);
    renderPanel({ onReplay });

    fireEvent.change(screen.getByRole("combobox", { name: "Replay model" }), { target: { value: "model-a" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Max reported outcomes"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Run replay" }));

    await waitFor(() =>
      expect(onReplay).toHaveBeenCalledWith({ modelId: "model-a", datasetIds: ["dataset-a"], maxOutcomes: 50 }),
    );
    expect(await screen.findByText(/matched 8 of 10 windows/i)).toBeInTheDocument();
  });

  it("shows an error alert when replay fails", async () => {
    const onReplay = vi.fn().mockRejectedValue(new Error("replay timed out"));
    renderPanel({ onReplay });

    fireEvent.change(screen.getByRole("combobox", { name: "Replay model" }), { target: { value: "model-a" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Run replay" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("replay timed out");
  });

  it("flags truncated outcomes", async () => {
    renderPanel({ onReplay: vi.fn().mockResolvedValue({ ...REPORT, outcomes_truncated: true }) });

    fireEvent.change(screen.getByRole("combobox", { name: "Replay model" }), { target: { value: "model-a" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Run replay" }));

    expect(await screen.findByText(/outcomes truncated/i)).toBeInTheDocument();
  });
});
