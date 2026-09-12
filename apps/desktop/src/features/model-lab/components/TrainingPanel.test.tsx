import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrainingPanel } from "./TrainingPanel";
import { TooltipProvider } from "../../../components/ui/tooltip";
import type { TrainingStatus } from "../types";

afterEach(() => cleanup());

function renderPanel(overrides: Partial<React.ComponentProps<typeof TrainingPanel>> = {}) {
  const props: React.ComponentProps<typeof TrainingPanel> = {
    trainingBackend: "tflite",
    onBackendChange: vi.fn(),
    status: { phase: "idle" },
    logs: [],
    trainingError: null,
    selectedCount: 0,
    onStart: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<TooltipProvider><TrainingPanel {...props} /></TooltipProvider>);
  return props;
}

describe("TrainingPanel", () => {
  it("exposes an accessible Training region", () => {
    renderPanel();
    expect(screen.getByRole("region", { name: "Training" })).toBeInTheDocument();
  });

  it("reveals the dev-runner requirement once expanded", () => {
    renderPanel();
    expect(screen.queryByText(/uv run --project tools\/pinch-classifier/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Training requirements and advanced settings"));
    expect(screen.getByText(/uv run --project tools\/pinch-classifier/i)).toBeInTheDocument();
  });

  it("keeps Start training disabled with no dataset selected", () => {
    renderPanel({ selectedCount: 0 });
    expect(screen.getByRole("button", { name: "Start training" })).toBeDisabled();
  });

  it("enables Start training once a dataset is selected, and calls onStart", () => {
    const onStart = vi.fn();
    renderPanel({ selectedCount: 1, onStart });
    const startButton = screen.getByRole("button", { name: "Start training" });
    expect(startButton).toBeEnabled();
    fireEvent.click(startButton);
    expect(onStart).toHaveBeenCalled();
  });

  it("selects the sklearn backend", () => {
    const onBackendChange = vi.fn();
    renderPanel({ onBackendChange });
    fireEvent.click(screen.getByRole("radio", { name: /scikit-learn \(baseline only\)/i }));
    expect(onBackendChange).toHaveBeenCalledWith("sklearn");
  });

  it("shows running state and log lines, and enables cancel", () => {
    const status: TrainingStatus = { phase: "running", jobId: "job-1", datasetIds: ["dataset-a"], backend: "tflite", startedAt: "2026-09-01T00:00:00Z" };
    renderPanel({ status, logs: ["training started"], selectedCount: 1 });
    expect(screen.getByText(/running job job-1/i)).toBeInTheDocument();
    expect(screen.getByText("training started")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Training…" })).toBeDisabled();
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton).toBeEnabled();
  });

  it("does not allow cancel when no job is running", () => {
    const onCancel = vi.fn();
    renderPanel({ onCancel });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("shows a failure message from a failed status", () => {
    renderPanel({ status: { phase: "failed", jobId: "job-1", message: "trainer exited with code 1" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/trainer exited with code 1/i);
  });
});
