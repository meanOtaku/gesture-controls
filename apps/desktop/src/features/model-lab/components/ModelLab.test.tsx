import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelLab } from "./ModelLab";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const status = { mode: "monitor", loadedLabels: ["snap"], loadFailures: [], quarantined: [], registryError: null, activeDetections: [], lastScores: {} };
const models = [{ id: "snap-1", label: "snap", state: "active", deployable: true, imported: true, modelSha256: "x", createdAt: "2026-10-05", active: true }];
const datasets = [
  { id: "d1", originalFilename: "a.csv", importedAt: "", label: "snap", rowCount: 10 },
  { id: "d2", originalFilename: "b.csv", importedAt: "", label: "snap", rowCount: 12 },
];

describe("ModelLab", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case "list_label_models": return models;
        case "get_label_runtime_status": return status;
        case "list_model_datasets": return datasets;
        case "list_model_labels": return [];
        default: return undefined;
      }
    });
  });
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("is organised around label models, with no legacy training or LiteRT panels", async () => {
    render(<ModelLab />);
    const overview = within(screen.getByRole("region", { name: "Model Lab overview" }));
    await waitFor(() => expect(overview.getByText("monitor")).toBeInTheDocument());
    expect(overview.getByText("1 registered")).toBeInTheDocument();
    expect(overview.getByText("1 label covered")).toBeInTheDocument();
    for (const name of ["Label models", "Train a model", "Detection activity", "Labels", "Recordings"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
    for (const gone of [/LiteRT/i, /training role/i, /safe intent/i, /Start training/i]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it("makes no desktop calls in the browser preview and says so", () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    render(<ModelLab />);
    expect(screen.getByText("You’re viewing the browser preview")).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
