import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import trees from "../fixtures/inspection-trees.json";
import { ModelLab } from "./ModelLab";
import { ModelPipeline } from "./ModelPipeline";
import { resetRuntimeModeForTests } from "../runtimeMode";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

const status = { mode: "monitor", loadedLabels: [], loadFailures: [], quarantined: [], registryError: null, activeDetections: [], lastScores: {} };
const models = [
  { id: "snap-1", label: "snap", state: "approved", deployable: true, imported: false, modelSha256: "x", createdAt: "2026-10-05", active: false },
  { id: "fist-1", label: "fist", state: "draft", deployable: true, imported: true, modelSha256: "y", createdAt: "2026-10-06", active: false },
];
const datasets = [
  { id: "d1", originalFilename: "a.csv", importedAt: "", label: "snap", labels: ["snap"], rowCount: 10 },
  { id: "d2", originalFilename: "b.csv", importedAt: "", label: "idle", labels: ["idle"], rowCount: 12 },
];
const labels = [{ id: "snap", displayName: "Snap", description: "", color: "#fff", role: "positiveGesture", archivedAt: null }];

beforeEach(() => {
  invokeMock.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invokeMock.mockImplementation(async (command: string, args?: { id?: string }) => {
    switch (command) {
      case "list_label_models": return models;
      case "get_label_runtime_status": return status;
      case "list_model_datasets": return datasets;
      case "list_model_labels": return labels;
      case "check_label_trainer": return { available: true, detail: "uv" };
      case "get_label_training_status": return { running: null, last: null };
      case "plan_label_training": return { train: ["d1"], evaluation: ["d2"], problem: null, inputs: 1701 };
      case "inspect_label_model": return { id: args?.id, label: "snap", origin: "trained", manifest: {}, inspection: trees };
      default: return undefined;
    }
  });
});
afterEach(() => {
  cleanup();
  resetRuntimeModeForTests();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("ModelPipeline", () => {
  it("shows both kinds of model's pipelines and research results", () => {
    render(<ModelPipeline />);
    const pipeline = screen.getByRole("region", { name: "PPG + IMU pinch-start model pipeline" });
    expect(within(pipeline).getAllByRole("listitem")).toHaveLength(6);
    expect(within(pipeline).getByRole("list", { name: "Pipeline stages" })).toHaveTextContent("ExtraTrees");
    expect(within(pipeline).getByLabelText("Research results")).toHaveTextContent("0.873");
    const cnn = screen.getByRole("region", { name: "CNN pinch-start model pipeline" });
    expect(within(cnn).getAllByRole("listitem")).toHaveLength(5);
    expect(within(cnn).getByRole("list", { name: "Pipeline stages" })).toHaveTextContent("median and spread");
    expect(within(cnn).getByLabelText("Research results")).toHaveTextContent("69%");
  });
});

describe("Model Lab, where the Network lab was", () => {
  it("folds how the models work away, and opens it from the Train card's link", async () => {
    render(<ModelLab />);
    expect(screen.queryByRole("region", { name: "CNN pinch-start model pipeline" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "See how it works" }));
    expect(await screen.findByRole("region", { name: "CNN pinch-start model pipeline" })).toBeInTheDocument();
  });

  it("looks inside a model from its More menu, and closes it", async () => {
    render(<ModelLab />);
    fireEvent.click(await screen.findByRole("button", { name: "More actions for snap-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect snap-1" }));
    expect(await screen.findByRole("region", { name: "Inspect snap-1" })).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("inspect_label_model", { id: "snap-1" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Inspect snap-1" })).not.toBeInTheDocument());
  });
});
