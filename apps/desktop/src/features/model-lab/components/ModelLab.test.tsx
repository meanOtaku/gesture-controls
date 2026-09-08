import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../../app/App";

const invokeMock = vi.fn();
const listenMock = vi.fn();
let trainingEventHandler: ((event: { payload: unknown }) => void) | undefined;
const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listenMock(...args) }));

const DATASET_A = {
  id: "dataset-a",
  originalFilename: "session-1.csv",
  importedAt: "2026-08-31T00:00:00Z",
  label: "pinch_start",
  rowCount: 42,
};

const MODEL_CARD = {
  created_at: "2026-08-31T01:00:00Z",
  metrics: { accuracy: 0.9, macro_f1: 0.85, false_activation_rate: 0.01 },
};

const TRAINED_MODEL_A = { id: "model-a", backend: "tflite", modelCard: MODEL_CARD };
const REGISTRY_MODEL_A = { id: "model-a", state: "draft", createdAt: "2026-08-31T01:00:00Z", intentBindings: [] };
const COMPLETE_BINDINGS = [
  { classLabel: "negative", intent: "noAction" },
  { classLabel: "pinch_start", intent: "volumeGrab" },
  { classLabel: "pinch_release", intent: "volumeRelease" },
];

async function openModelLab() {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Model Lab" }));
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("list_model_datasets"));
}

describe("ModelLab", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    trainingEventHandler = undefined;
    eventHandlers.clear();
    listenMock.mockImplementation((event: string, handler: (event: { payload: unknown }) => void) => {
      eventHandlers.set(event, handler);
      if (event === "model-lab-training-event") trainingEventHandler = handler;
      return Promise.resolve(() => undefined);
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
  });

  it("opens from the nav tab, shows every workflow section, and reports the dev-runner requirement truthfully", async () => {
    await openModelLab();

    for (const sectionLabel of ["Desktop readiness", "Dataset", "Label coverage", "Training", "Evaluation", "Export and deploy"]) {
      expect(screen.getByRole("region", { name: sectionLabel })).toBeInTheDocument();
    }

    expect(screen.getAllByText(/uv run --project tools\/pinch-classifier/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/managed tauri runner is the next integration slice/i)).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Start training" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Monitor" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Live" })).toBeDisabled();
    expect(screen.getByText(/inference is fail-closed/i)).toBeInTheDocument();

    expect(await screen.findByText(/no dataset sessions imported yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no trained models yet/i)).toBeInTheDocument();
  });

  it("shows locally checked first-run requirements and can recheck them", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_environment_diagnostics") {
        return Promise.resolve([
          { id: "training-runner", title: "Training and replay runner", status: "attention", detail: "uv was not found on PATH.", action: "Install uv and restart the app." },
          { id: "volume-backend", title: "System volume backend", status: "ready", detail: "The desktop can read the host system volume.", action: null },
        ]);
      }
      if (command === "list_model_datasets") return Promise.resolve([]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    expect(await screen.findByText("Training and replay runner")).toBeInTheDocument();
    expect(screen.getByText(/install uv and restart the app/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === "get_environment_diagnostics")).toHaveLength(2));
  });

  it("fetches training status and trained models on mount", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([DATASET_A]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([TRAINED_MODEL_A]);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    expect(invokeMock).toHaveBeenCalledWith("get_training_status");
    expect(invokeMock).toHaveBeenCalledWith("list_trained_models");
    expect(await screen.findByText(/model-a/)).toBeInTheDocument();
    expect(screen.getByText(/accuracy 90\.0%/)).toBeInTheDocument();
  });

  it("loads imported sessions on mount and shows label plus row count", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([DATASET_A]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    expect(await screen.findByText(/session-1\.csv.*pinch start.*42 rows/i)).toBeInTheDocument();
  });

  it("derives label coverage counts from imported sessions", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([DATASET_A]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    await screen.findByText(/session-1\.csv/i);
    const pinchStartRow = screen.getByText("pinch start").closest(".model-lab-label-row");
    expect(pinchStartRow).not.toBeNull();
    expect(pinchStartRow).toHaveTextContent("1 session");

    const idleRow = screen.getByText("idle").closest(".model-lab-label-row");
    expect(idleRow).not.toBeNull();
    expect(idleRow).toHaveTextContent("0 sessions");
  });

  it("imports a selected CSV file via a hidden file input and refreshes the list", async () => {
    let listCallCount = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") {
        listCallCount += 1;
        return Promise.resolve(listCallCount === 1 ? [] : [DATASET_A]);
      }
      if (command === "import_model_dataset") return Promise.resolve(DATASET_A);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    const file = new File(["# label: pinch_start\ncsv,content"], "session-1.csv", { type: "text/csv" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("import_model_dataset", {
        filename: "session-1.csv",
        csvContent: "# label: pinch_start\ncsv,content",
      }),
    );

    expect(await screen.findByText(/session-1\.csv.*pinch start.*42 rows/i)).toBeInTheDocument();
  });

  it("deletes an imported session and refreshes the list", async () => {
    let listCallCount = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") {
        listCallCount += 1;
        return Promise.resolve(listCallCount === 1 ? [DATASET_A] : []);
      }
      if (command === "delete_model_dataset") return Promise.resolve(undefined);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    await screen.findByText(/session-1\.csv/i);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("delete_model_dataset", { id: "dataset-a" }));
    expect(await screen.findByText(/no dataset sessions imported yet/i)).toBeInTheDocument();
  });

  it("shows an operation error when loading sessions fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.reject(new Error("disk unavailable"));
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    expect(await screen.findByRole("alert")).toHaveTextContent(/disk unavailable/i);
  });

  it("shows an operation error when import fails and does not add a row", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([]);
      if (command === "import_model_dataset") return Promise.reject(new Error("bad header"));
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    const file = new File(["bad,csv"], "broken.csv", { type: "text/csv" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent(/bad header/i);
    expect(screen.getByText(/no dataset sessions imported yet/i)).toBeInTheDocument();
  });

  it("keeps Start training disabled with no dataset selected, and enables it once a dataset is checked", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([DATASET_A]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await openModelLab();
    await screen.findByText(/session-1\.csv/i);

    const startButton = screen.getByRole("button", { name: "Start training" });
    expect(startButton).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /select session-1\.csv/i }));
    expect(startButton).not.toBeDisabled();
  });

  it("starts a training job with the selected dataset ids", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([DATASET_A]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      if (command === "start_training_job") return Promise.resolve("job-1");
      return Promise.resolve(undefined);
    });

    await openModelLab();
    await screen.findByText(/session-1\.csv/i);

    fireEvent.click(screen.getByRole("checkbox", { name: /select session-1\.csv/i }));
    fireEvent.click(screen.getByRole("button", { name: "Start training" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_training_job", {
        datasetIds: ["dataset-a"],
        backend: "tflite",
      }),
    );
  });

  it("starts a training job with the sklearn backend once selected", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([DATASET_A]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      if (command === "start_training_job") return Promise.resolve("job-1");
      return Promise.resolve(undefined);
    });

    await openModelLab();
    await screen.findByText(/session-1\.csv/i);

    fireEvent.click(screen.getByRole("checkbox", { name: /select session-1\.csv/i }));
    fireEvent.click(screen.getByRole("radio", { name: /scikit-learn \(baseline only\)/i }));
    fireEvent.click(screen.getByRole("button", { name: "Start training" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_training_job", {
        datasetIds: ["dataset-a"],
        backend: "sklearn",
      }),
    );
  });

  it("shows running state and log lines from training events, then enables cancel", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([DATASET_A]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      if (command === "start_training_job") return Promise.resolve("job-1");
      return Promise.resolve(undefined);
    });

    await openModelLab();
    await screen.findByText(/session-1\.csv/i);

    fireEvent.click(screen.getByRole("checkbox", { name: /select session-1\.csv/i }));
    fireEvent.click(screen.getByRole("button", { name: "Start training" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_training_job", {
        datasetIds: ["dataset-a"],
        backend: "tflite",
      }),
    );

    trainingEventHandler?.({
      payload: { kind: "started", jobId: "job-1", datasetIds: ["dataset-a"], backend: "tflite" },
    });
    trainingEventHandler?.({ payload: { kind: "log", jobId: "job-1", message: "training started" } });

    expect(await screen.findByText(/running job job-1/i)).toBeInTheDocument();
    expect(screen.getByText("training started")).toBeInTheDocument();

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Training…" })).toBeDisabled();

    fireEvent.click(cancelButton);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_training_job", { jobId: "job-1" }));
  });

  it("shows a completed model and refreshes the trained model list", async () => {
    let modelListCallCount = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([DATASET_A]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") {
        modelListCallCount += 1;
        return Promise.resolve(modelListCallCount === 1 ? [] : [TRAINED_MODEL_A]);
      }
      if (command === "start_training_job") return Promise.resolve("job-1");
      return Promise.resolve(undefined);
    });

    await openModelLab();
    await screen.findByText(/session-1\.csv/i);

    trainingEventHandler?.({
      payload: { kind: "completed", jobId: "job-1", modelId: "model-a", backend: "tflite", modelCard: MODEL_CARD },
    });

    expect(await screen.findByText(/job job-1 completed/i)).toBeInTheDocument();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("list_trained_models"));
    expect((await screen.findAllByText(/model-a/)).length).toBeGreaterThanOrEqual(1);
  });

  it("shows a failure message from a failed training event", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([DATASET_A]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await openModelLab();
    await screen.findByText(/session-1\.csv/i);

    trainingEventHandler?.({ payload: { kind: "failed", jobId: "job-1", message: "trainer exited with code 1" } });

    expect(await screen.findByRole("alert")).toHaveTextContent(/trainer exited with code 1/i);
  });

  it("does not allow cancel when no job is running", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(invokeMock).not.toHaveBeenCalledWith("cancel_training_job", expect.anything());
  });

  it("moves registered models through lifecycle approval and only offers activation after approval", async () => {
    const draftRegistry = { models: [REGISTRY_MODEL_A], activeModelId: null, previousActiveModelId: null, inferenceMode: "off" };
    const approvedRegistry = {
      ...draftRegistry,
      models: [{ ...REGISTRY_MODEL_A, state: "approved", intentBindings: COMPLETE_BINDINGS }],
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([TRAINED_MODEL_A]);
      if (command === "get_model_registry") return Promise.resolve(draftRegistry);
      if (command === "transition_model_state") return Promise.resolve(approvedRegistry);
      if (command === "activate_model") return Promise.resolve({ ...approvedRegistry, activeModelId: "model-a", models: [{ ...REGISTRY_MODEL_A, state: "active" }] });
      return Promise.resolve(undefined);
    });

    await openModelLab();
    expect(await screen.findByRole("button", { name: "Mark evaluated" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mark evaluated" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("transition_model_state", { id: "model-a", to: "evaluated" }));

    eventHandlers.get("model-registry-updated")?.({ payload: approvedRegistry });
    fireEvent.click(await screen.findByRole("button", { name: "Activate" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("activate_model", { id: "model-a" }));
  });

  it("only offers safe intents per class and saves bindings through set_model_intent_bindings", async () => {
    const registry = { models: [REGISTRY_MODEL_A], activeModelId: null, previousActiveModelId: null, inferenceMode: "off" };
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([TRAINED_MODEL_A]);
      if (command === "get_model_registry") return Promise.resolve(registry);
      if (command === "set_model_intent_bindings") return Promise.resolve(registry);
      return Promise.resolve(undefined);
    });

    await openModelLab();
    await screen.findByRole("button", { name: "Mark evaluated" });

    const negativeSelect = screen.getByRole("combobox", { name: "negative intent for model-a" });
    expect(Array.from(negativeSelect.querySelectorAll("option")).map((option) => option.textContent)).toEqual([
      "No action",
    ]);

    const pinchStartSelect = screen.getByRole("combobox", { name: "pinch_start intent for model-a" });
    expect(Array.from(pinchStartSelect.querySelectorAll("option")).map((option) => option.textContent)).toEqual([
      "Begin volume grab",
      "No action",
    ]);

    fireEvent.change(pinchStartSelect, { target: { value: "volumeGrab" } });
    const pinchReleaseSelect = screen.getByRole("combobox", { name: "pinch_release intent for model-a" });
    fireEvent.change(pinchReleaseSelect, { target: { value: "volumeRelease" } });

    fireEvent.click(screen.getByRole("button", { name: "Save bindings" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_model_intent_bindings", {
        id: "model-a",
        bindings: [
          { classLabel: "negative", intent: "noAction" },
          { classLabel: "pinch_start", intent: "volumeGrab" },
          { classLabel: "pinch_release", intent: "volumeRelease" },
        ],
      }),
    );
  });

  it("keeps Activate disabled for an approved model with incomplete bindings, and enables it once bindings are complete", async () => {
    const incompleteBindings = [
      { classLabel: "negative", intent: "noAction" },
      { classLabel: "pinch_start", intent: "noAction" },
    ];
    const approvedIncomplete = {
      models: [{ ...REGISTRY_MODEL_A, state: "approved", intentBindings: incompleteBindings }],
      activeModelId: null,
      previousActiveModelId: null,
      inferenceMode: "off",
    };
    const approvedComplete = {
      ...approvedIncomplete,
      models: [{ ...REGISTRY_MODEL_A, state: "approved", intentBindings: COMPLETE_BINDINGS }],
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([TRAINED_MODEL_A]);
      if (command === "get_model_registry") return Promise.resolve(approvedIncomplete);
      if (command === "activate_model") return Promise.resolve({ ...approvedComplete, activeModelId: "model-a" });
      return Promise.resolve(undefined);
    });

    await openModelLab();

    const activateButton = await screen.findByRole("button", { name: "Activate" });
    expect(activateButton).toBeDisabled();

    eventHandlers.get("model-registry-updated")?.({ payload: approvedComplete });

    await waitFor(() => expect(screen.getByRole("button", { name: "Activate" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("activate_model", { id: "model-a" }));
  });

  it("marks a scikit-learn trained model as non-deployable and explains why", async () => {
    const sklearnModel = { id: "model-b", backend: "sklearn", modelCard: MODEL_CARD };
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([sklearnModel]);
      return Promise.resolve(undefined);
    });

    await openModelLab();

    expect(await screen.findByText(/scikit-learn — not deployable/i)).toBeInTheDocument();
    expect(
      screen.getByText(/it has no litert bundle, so it cannot be bound to intents, approved, or activated/i),
    ).toBeInTheDocument();
  });

  it("offers rollback only when the persisted registry has a prior active model", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_model_datasets") return Promise.resolve([]);
      if (command === "get_training_status") return Promise.resolve({ phase: "idle" });
      if (command === "list_trained_models") return Promise.resolve([]);
      if (command === "get_model_registry") return Promise.resolve({ models: [], activeModelId: "model-b", previousActiveModelId: "model-a", inferenceMode: "monitor" });
      if (command === "rollback_active_model") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    await openModelLab();
    const rollback = await screen.findByRole("button", { name: "Rollback active model" });
    expect(rollback).not.toBeDisabled();
    fireEvent.click(rollback);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("rollback_active_model"));
  });
});
