import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("start_label_fine_tune", { id: "snap-1", planId: "builtin-head" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows why it could not start and stays open", async () => {
    const onClose = vi.fn();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "start_label_fine_tune") throw "fine-tuning needs one of the PyTorch methods";
      return saved;
    });
    render(<FineTuneModel modelId="snap-1" onClose={onClose} />);
    await screen.findByLabelText("Fine-tune plan");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start fine-tuning" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Start fine-tuning" }));
    expect(await screen.findByText(/needs one of the PyTorch methods/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
