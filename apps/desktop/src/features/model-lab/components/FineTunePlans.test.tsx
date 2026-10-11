import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetSummary } from "../types";
import { FineTuneModel } from "./FineTuneModel";
import { FineTunePlans } from "./FineTunePlans";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const plan = (id: string, name: string, builtIn: boolean, extra = {}) => ({ id, name, description: "", epochs: 30, learningRate: null, freeze: "none", builtIn, ...extra });
let saved: unknown[] = [];

beforeEach(() => {
  invokeMock.mockReset();
  saved = [plan("builtin-continue", "Keep training", true), plan("builtin-head", "Retrain the output layer", true, { freeze: "allButOutput" }), plan("p1", "Mine", false)];
  invokeMock.mockImplementation(async (command: string, args?: { id?: string; plan?: { name: string } }) => {
    switch (command) {
      case "list_fine_tune_plans": return saved;
      case "save_fine_tune_plan": saved = [...saved, { ...args!.plan, id: "new", builtIn: false }]; return saved;
      case "delete_fine_tune_plan": saved = saved.filter((p) => (p as { id: string }).id !== args?.id); return saved;
      case "start_label_fine_tune": return "run-1";
      default: return undefined;
    }
  });
});
afterEach(cleanup);

describe("FineTunePlans", () => {
  it("lists built-in and own plans, built-in ones without delete", async () => {
    render(<FineTunePlans desktopAvailable />);
    expect(await screen.findByText("Keep training")).toBeInTheDocument();
    expect(screen.getByText(/only the output layer changes/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete plan Keep training" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete plan Mine" })).toBeInTheDocument();
  });

  it("duplicates a plan, changes it and saves the copy", async () => {
    render(<FineTunePlans desktopAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "Duplicate plan Keep training" }));
    fireEvent.change(screen.getByLabelText("Plan name"), { target: { value: "Longer" } });
    fireEvent.change(screen.getByLabelText("Rounds"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("save_fine_tune_plan", { plan: expect.objectContaining({ id: "", name: "Longer", epochs: 80, learningRate: null }) }));
  });

  it("shows a built-in plan read-only, and asks before deleting", async () => {
    render(<FineTunePlans desktopAvailable />);
    fireEvent.click(await screen.findByRole("button", { name: "View plan Keep training" }));
    expect(await screen.findByText(/cannot be changed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save plan" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete plan Mine" }));
    expect(invokeMock).not.toHaveBeenCalledWith("delete_fine_tune_plan", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Delete plan Mine for good" }));
    await waitFor(() => expect(screen.queryByText("Mine")).toBeNull());
  });
});

describe("FineTuneModel", () => {
  it("starts fine-tuning a model with the chosen plan", async () => {
    const onClose = vi.fn();
    render(<FineTuneModel modelId="snap-1" onClose={onClose} />);
    fireEvent.change(await screen.findByLabelText("Fine-tune plan"), { target: { value: "builtin-head" } });
    fireEvent.click(screen.getByRole("button", { name: "Start fine-tuning" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("start_label_fine_tune", { id: "snap-1", planId: "builtin-head", extraDatasetIds: [], extraWeight: null }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows why it could not start and stays open", async () => {
    const onClose = vi.fn();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "start_label_fine_tune") throw "fine-tuning needs one of the PyTorch methods";
      return command === "list_fine_tune_plans" ? saved : undefined;
    });
    render(<FineTuneModel modelId="snap-1" onClose={onClose} />);
    await screen.findByLabelText("Fine-tune plan");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start fine-tuning" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Start fine-tuning" }));
    expect(await screen.findByText(/needs one of the PyTorch methods/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

const dataset = (id: string, labels: string[], sequence: number): DatasetSummary => ({ id, originalFilename: `${id}.csv`, importedAt: "", label: labels.join(", "), labels, rowCount: 10, sequence });
const info = { label: "snap", backend: "torch-mlp", negatives: ["idle"], excludes: ["walking"], datasetIds: ["d1", "d2"], trainOnly: [], designId: null };

describe("FineTuneModel extra recordings", () => {
  beforeEach(() => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_fine_tune_plans") return saved;
      if (command === "get_model_training_info") return info;
      if (command === "start_label_fine_tune") return "run-1";
      return undefined;
    });
  });

  it("offers recordings the model did not use, in import order, and refuses ones with a label it has no role for", async () => {
    render(<FineTuneModel modelId="snap-1" onClose={() => undefined} datasets={[dataset("d2", ["snap"], 2), dataset("x2", ["snap", "idle"], 6), dataset("x1", ["snap", "idle"], 5), dataset("x3", ["snap", "mystery"], 7)]} />);
    const list = await screen.findByRole("list", { name: "Extra recordings" });
    const names = Array.from(list.querySelectorAll("li")).map((li) => li.textContent);
    expect(names).toHaveLength(3); // d2 was already used
    expect(names[0]).toContain("#5");
    expect(names[1]).toContain("#6");
    expect(screen.getByRole("checkbox", { name: "Also learn from x3.csv" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/“mystery”, which this model was not trained with a role for/)).toBeInTheDocument();
  });

  it("sends the chosen extra recordings and how much they count", async () => {
    render(<FineTuneModel modelId="snap-1" onClose={() => undefined} datasets={[dataset("x1", ["snap", "idle"], 5)]} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Also learn from x1.csv" }));
    fireEvent.change(screen.getByLabelText("How much the extra recordings count"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Start fine-tuning" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("start_label_fine_tune", { id: "snap-1", planId: "builtin-continue", extraDatasetIds: ["x1"], extraWeight: 5 }));
  });
});
