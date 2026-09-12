import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRegistryTable } from "./ModelRegistryTable";
import { TooltipProvider } from "../../../components/ui/tooltip";
import type { TrainedModelSummary } from "../types";

afterEach(() => cleanup());

const MODEL_CARD = {
  created_at: "2026-08-31T01:00:00Z",
  metrics: { accuracy: 0.9, macro_f1: 0.85, false_activation_rate: 0.01 },
};

function renderTable(trainedModels: TrainedModelSummary[]) {
  render(<TooltipProvider><ModelRegistryTable trainedModels={trainedModels} /></TooltipProvider>);
}

describe("ModelRegistryTable", () => {
  it("exposes an accessible Evaluation region", () => {
    renderTable([]);
    expect(screen.getByRole("region", { name: "Evaluation" })).toBeInTheDocument();
    expect(screen.getByText(/no trained models yet/i)).toBeInTheDocument();
  });

  it("shows metrics for a trained model", () => {
    renderTable([{ id: "model-a", backend: "tflite", modelCard: MODEL_CARD }]);
    expect(screen.getByText(/model-a/)).toBeInTheDocument();
    expect(screen.getByText(/accuracy 90\.0%/)).toBeInTheDocument();
    expect(screen.getByText("TFLite — deployable")).toBeInTheDocument();
  });

  it("marks a scikit-learn model as non-deployable and explains why", () => {
    renderTable([{ id: "model-b", backend: "sklearn", modelCard: MODEL_CARD }]);
    expect(screen.getByText(/scikit-learn — not deployable/i)).toBeInTheDocument();
    expect(
      screen.getByText(/it has no litert bundle, so it cannot be bound to intents, approved, or activated/i),
    ).toBeInTheDocument();
  });

  it("sorts trained models by creation time, newest first", () => {
    renderTable([
      { id: "model-old", backend: "tflite", modelCard: { ...MODEL_CARD, created_at: "2026-01-01T00:00:00Z" } },
      { id: "model-new", backend: "tflite", modelCard: { ...MODEL_CARD, created_at: "2026-06-01T00:00:00Z" } },
    ]);
    const rows = screen.getAllByText(/model-(old|new)/);
    expect(rows[0]).toHaveTextContent("model-new");
    expect(rows[1]).toHaveTextContent("model-old");
  });
});
