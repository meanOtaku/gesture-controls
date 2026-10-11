import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dense from "../fixtures/inspection-dense.json";
import { NetworkLab } from "./NetworkLab";

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

function Harness({ start = null }: { start?: string | null }) {
  const [id, setId] = useState<string | null>(start);
  return <NetworkLab modelId={id} onModelChange={setId} />;
}

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
      case "plan_label_training": return { train: ["d1"], evaluation: ["d2"], problem: null, available: ["accel_x_std"], features: ["accel_x_std"] };
      case "inspect_label_model": return { id: args?.id, label: "snap", origin: "trained", manifest: {}, inspection: dense };
      default: return undefined;
    }
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("NetworkLab", () => {
  it("is the workbench for networks: the full training panel, and the models to look inside", async () => {
    render(<Harness />);
    expect(screen.getByRole("heading", { name: "Network lab" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Network designs" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Your models" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Models" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText(/imported/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Inspect/ })).not.toBeInTheDocument();
    // Training happens in Model Lab: the Network lab has no training panel.
    expect(screen.queryByLabelText("Label to teach")).not.toBeInTheDocument();
  });

  it("looks inside a chosen model, and closes it", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Look inside snap-1" }));
    expect(await screen.findByRole("region", { name: "Inspect snap-1" })).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("inspect_label_model", { id: "snap-1" });
    expect(screen.getByRole("button", { name: "Look inside snap-1" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Inspect snap-1" })).not.toBeInTheDocument());
  });

  it("opens straight on a model it was sent to, and lets go of one that no longer exists", async () => {
    render(<Harness start="snap-1" />);
    expect(await screen.findByRole("region", { name: "Inspect snap-1" })).toBeInTheDocument();
    cleanup();
    render(<Harness start="gone-9" />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Inspect gone-9" })).not.toBeInTheDocument());
  });

  it("says so in the browser preview", () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    render(<Harness />);
    expect(screen.getByText("You’re viewing the browser preview")).toBeInTheDocument();
  });
});
