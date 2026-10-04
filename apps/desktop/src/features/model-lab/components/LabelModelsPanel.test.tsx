import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelModel, LabelRuntimeStatus } from "../labelModels";
import { LabelModelsPanel } from "./LabelModelsPanel";

const invokeMock = vi.fn();
const openMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => openMock(...args) }));

const draft: LabelModel = {
  id: "snap-abc", label: "snap", state: "draft", deployable: true, imported: true, modelSha256: "x", createdAt: "2026-10-05T00:00:00Z", active: false,
};
const baseStatus: LabelRuntimeStatus = {
  mode: "monitor", loadedLabels: [], loadFailures: [], quarantined: [], registryError: null, activeDetections: [], lastScores: {},
};

function setup(models: LabelModel[], status: Partial<LabelRuntimeStatus> = {}) {
  let current = models;
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "list_label_models") return current;
    if (command === "get_label_runtime_status") return { ...baseStatus, ...status };
    return undefined;
  });
  render(<LabelModelsPanel desktopAvailable />);
  return { set: (next: LabelModel[]) => { current = next; } };
}

const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);

describe("LabelModelsPanel", () => {
  beforeEach(() => { invokeMock.mockReset(); openMock.mockReset(); });
  afterEach(cleanup);

  it("says so when there are no models and does nothing outside the desktop app", () => {
    cleanup();
    render(<LabelModelsPanel desktopAvailable={false} />);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Import a model folder" })).toBeDisabled();
  });

  it("imports the chosen folder, and does nothing when the dialog is cancelled", async () => {
    setup([]);
    openMock.mockResolvedValueOnce(null);
    fireEvent.click(await screen.findByRole("button", { name: "Import a model folder" }));
    await waitFor(() => expect(openMock).toHaveBeenCalled());
    expect(calls("import_label_model")).toHaveLength(0);
    openMock.mockResolvedValueOnce("/tmp/bundle");
    invokeMock.mockImplementation(async (c: string) => (c === "import_label_model" ? { id: "snap-abc", label: "snap", modelSha256: "x", projectCreated: true } : c === "list_label_models" ? [] : baseStatus));
    fireEvent.click(screen.getByRole("button", { name: "Import a model folder" }));
    await waitFor(() => expect(calls("import_label_model")).toEqual([["import_label_model", { path: "/tmp/bundle" }]]));
  });

  it("shows the backend's reason when an import is refused", async () => {
    setup([]);
    openMock.mockResolvedValueOnce("/tmp/bad");
    invokeMock.mockImplementation(async (c: string) => {
      if (c === "import_label_model") throw "the model hash does not match";
      return c === "list_label_models" ? [] : baseStatus;
    });
    fireEvent.click(await screen.findByRole("button", { name: "Import a model folder" }));
    expect(await screen.findByText(/hash does not match/)).toBeInTheDocument();
  });

  it("walks a model through the lifecycle with explicit buttons, and only Approved can be activated", async () => {
    setup([draft]);
    expect(await screen.findByText("snap-abc")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Activate/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark as evaluated snap-abc" }));
    await waitFor(() => expect(calls("set_label_model_state")).toEqual([["set_label_model_state", { id: "snap-abc", state: "evaluated" }]]));
  });

  it("activates an approved model and rolls back or deactivates an active one by label", async () => {
    setup([{ ...draft, state: "approved" }]);
    fireEvent.click(await screen.findByRole("button", { name: "Activate snap-abc" }));
    await waitFor(() => expect(calls("activate_label_model")).toEqual([["activate_label_model", { id: "snap-abc" }]]));
    cleanup();
    invokeMock.mockReset();
    setup([{ ...draft, state: "active", active: true }], { activeDetections: ["snap"], lastScores: { snap: 0.91 } });
    expect(await screen.findByText("Detected")).toBeInTheDocument();
    expect(screen.getByText("score 91%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate snap-abc" }));
    await waitFor(() => expect(calls("deactivate_label_model")).toEqual([["deactivate_label_model", { label: "snap" }]]));
    fireEvent.click(screen.getByRole("button", { name: "Roll back snap" }));
    await waitFor(() => expect(calls("rollback_label_model")).toEqual([["rollback_label_model", { label: "snap" }]]));
  });

  it("asks for confirmation before Live, and switches to Monitor or Off without asking", async () => {
    setup([], { mode: "monitor" });
    const group = await screen.findByRole("radiogroup");
    fireEvent.click(within(group).getByRole("radio", { name: /Live/ }));
    expect(await screen.findByText("Let models drive recipes?")).toBeInTheDocument();
    expect(calls("set_label_runtime_mode")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Stay in monitor" }));
    expect(calls("set_label_runtime_mode")).toHaveLength(0);
    fireEvent.click(within(group).getByRole("radio", { name: /Live/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Live" }));
    await waitFor(() => expect(calls("set_label_runtime_mode")).toEqual([["set_label_runtime_mode", { mode: "live" }]]));
    fireEvent.click(within(group).getByRole("radio", { name: /Off/ }));
    await waitFor(() => expect(calls("set_label_runtime_mode")).toContainEqual(["set_label_runtime_mode", { mode: "off" }]));
  });

  it("names a label whose active model could not be loaded, and a registry that could not open", async () => {
    setup([], { loadFailures: [{ label: "snap", version: "snap-abc", detail: "the model file was changed" }], registryError: "corrupt" });
    expect(await screen.findByText("snap has no running model")).toBeInTheDocument();
    expect(screen.getByText(/the model file was changed/)).toBeInTheDocument();
    expect(screen.getByText("The model registry could not be opened")).toBeInTheDocument();
    expect(within(screen.getByRole("radiogroup")).getByRole("radio", { name: /Live/ })).toHaveAttribute("aria-disabled", "true");
  });
});
