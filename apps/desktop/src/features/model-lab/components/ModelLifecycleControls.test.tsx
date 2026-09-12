import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelLifecycleControls } from "./ModelLifecycleControls";
import { usePendingActions } from "../hooks/usePendingActions";
import type { ModelRegistryModel, ModelRegistryView, TrainedModelSummary } from "../types";

afterEach(() => cleanup());

function Harness(props: {
  registry: ModelRegistryView | null;
  trainedModelById?: Map<string, TrainedModelSummary>;
  bindingError?: string | null;
  onTransition?: (id: string, to: string) => Promise<void>;
  onActivate?: (id: string) => Promise<void>;
  onRollback?: () => Promise<void>;
  onSaveBindings?: (id: string) => Promise<void>;
}) {
  const { isPending, run } = usePendingActions();
  return (
    <ModelLifecycleControls
      registry={props.registry}
      trainedModelById={props.trainedModelById ?? new Map()}
      bindingDrafts={{}}
      bindingError={props.bindingError ?? null}
      isPending={isPending}
      run={run}
      onDraftChange={vi.fn()}
      onSaveBindings={props.onSaveBindings ?? vi.fn().mockResolvedValue(undefined)}
      onTransition={(props.onTransition as never) ?? vi.fn().mockResolvedValue(undefined)}
      onActivate={props.onActivate ?? vi.fn().mockResolvedValue(undefined)}
      onRollback={props.onRollback ?? vi.fn().mockResolvedValue(undefined)}
    />
  );
}

function model(overrides: Partial<ModelRegistryModel> = {}): ModelRegistryModel {
  return { id: "model-a", state: "draft", createdAt: "2026-08-31T01:00:00Z", intentBindings: [], ...overrides };
}

describe("ModelLifecycleControls", () => {
  it("exposes an accessible Export and deploy region", () => {
    render(<Harness registry={{ models: [], activeModelId: null, previousActiveModelId: null, inferenceMode: "off" }} />);
    expect(screen.getByRole("region", { name: "Export and deploy" })).toBeInTheDocument();
    expect(screen.getByText(/no registered trained models yet/i)).toBeInTheDocument();
  });

  it("shows Mark evaluated for a draft model and calls onTransition", async () => {
    const onTransition = vi.fn().mockResolvedValue(undefined);
    render(
      <Harness
        registry={{ models: [model()], activeModelId: null, previousActiveModelId: null, inferenceMode: "off" }}
        onTransition={onTransition}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark evaluated" }));
    await waitFor(() => expect(onTransition).toHaveBeenCalledWith("model-a", "evaluated"));
  });

  it("offers Approve and Archive for an evaluated model", () => {
    render(
      <Harness registry={{ models: [model({ state: "evaluated" })], activeModelId: null, previousActiveModelId: null, inferenceMode: "off" }} />,
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
  });

  it("only enables Activate once approved, TFLite-backed, and bindings are complete", () => {
    const trainedModelById = new Map<string, TrainedModelSummary>([
      ["model-a", { id: "model-a", backend: "tflite", modelCard: {} }],
    ]);
    const { rerender } = render(
      <Harness
        registry={{ models: [model({ state: "approved" })], activeModelId: null, previousActiveModelId: null, inferenceMode: "off" }}
        trainedModelById={trainedModelById}
      />,
    );
    expect(screen.getByRole("button", { name: "Activate" })).toBeDisabled();

    rerender(
      <Harness
        registry={{
          models: [
            model({
              state: "approved",
              intentBindings: [
                { classLabel: "negative", intent: "noAction" },
                { classLabel: "pinch_start", intent: "volumeGrab" },
                { classLabel: "pinch_release", intent: "volumeRelease" },
              ],
            }),
          ],
          activeModelId: null,
          previousActiveModelId: null,
          inferenceMode: "off",
        }}
        trainedModelById={trainedModelById}
      />,
    );
    expect(screen.getByRole("button", { name: "Activate" })).toBeEnabled();
  });

  it("disables Rollback active model unless a previous active model exists", () => {
    const { rerender } = render(
      <Harness registry={{ models: [], activeModelId: "model-a", previousActiveModelId: null, inferenceMode: "off" }} />,
    );
    expect(screen.getByRole("button", { name: "Rollback active model" })).toBeDisabled();

    rerender(<Harness registry={{ models: [], activeModelId: "model-a", previousActiveModelId: "model-b", inferenceMode: "off" }} />);
    expect(screen.getByRole("button", { name: "Rollback active model" })).toBeEnabled();
  });

  it("calls onRollback when clicked", async () => {
    const onRollback = vi.fn().mockResolvedValue(undefined);
    render(
      <Harness
        registry={{ models: [], activeModelId: "model-a", previousActiveModelId: "model-b", inferenceMode: "off" }}
        onRollback={onRollback}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rollback active model" }));
    await waitFor(() => expect(onRollback).toHaveBeenCalled());
  });

  it("shows a binding error alert when present", () => {
    render(
      <Harness
        registry={{ models: [], activeModelId: null, previousActiveModelId: null, inferenceMode: "off" }}
        bindingError="Bindings rejected"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Bindings rejected");
  });

  it("explains that a scikit-learn model cannot be deployed", () => {
    const trainedModelById = new Map<string, TrainedModelSummary>([
      ["model-a", { id: "model-a", backend: "sklearn", modelCard: {} }],
    ]);
    render(
      <Harness
        registry={{ models: [model({ state: "approved" })], activeModelId: null, previousActiveModelId: null, inferenceMode: "off" }}
        trainedModelById={trainedModelById}
      />,
    );
    expect(screen.getByText(/scikit-learn baseline: not deployable/i)).toBeInTheDocument();
  });
});
