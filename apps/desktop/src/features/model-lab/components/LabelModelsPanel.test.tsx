import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelModel, LabelRuntimeStatus } from "../labelModels";
import { useLabelModels } from "../hooks/useLabelModels";
import { LabelModelsPanel } from "./LabelModelsPanel";

function Harness({ desktopAvailable = true, onInspect }: { desktopAvailable?: boolean; onInspect?: (id: string) => void }) {
  const { models, status, error, refresh } = useLabelModels(desktopAvailable);
  return <LabelModelsPanel desktopAvailable={desktopAvailable} models={models} status={status} loadError={error} refresh={refresh} onInspect={onInspect} />;
}

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

function setup(models: LabelModel[], status: Partial<LabelRuntimeStatus> = {}, onInspect?: (id: string) => void) {
  let current = models;
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "list_label_models") return current;
    if (command === "get_label_runtime_status") return { ...baseStatus, ...status };
    return undefined;
  });
  render(<Harness onInspect={onInspect} />);
  return { set: (next: LabelModel[]) => { current = next; } };
}

const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command);

describe("LabelModelsPanel", () => {
  beforeEach(() => { invokeMock.mockReset(); openMock.mockReset(); });
  afterEach(cleanup);

  it("offers Inspect for every model, and tells the page which one", async () => {
    const onInspect = vi.fn();
    setup([draft, { ...draft, id: "fist-1", label: "fist" }], {}, onInspect);
    fireEvent.click(await screen.findByRole("button", { name: "More actions for fist-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect fist-1" }));
    expect(onInspect).toHaveBeenCalledWith("fist-1");
    fireEvent.click(screen.getByRole("button", { name: "More actions for snap-abc" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect snap-abc" }));
    expect(onInspect).toHaveBeenLastCalledWith("snap-abc");
  });

  it("renames a model, shows its name above its id, and clears it when the name is emptied", async () => {
    const { set } = setup([draft]);
    fireEvent.click(await screen.findByRole("button", { name: "More actions for snap-abc" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename snap-abc" }));
    const box = screen.getByRole("textbox", { name: "Name for snap-abc" });
    fireEvent.change(box, { target: { value: "  Snap, CNN  " } });
    set([{ ...draft, name: "Snap, CNN" }]);
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(calls("rename_label_model")).toEqual([["rename_label_model", { id: "snap-abc", name: "Snap, CNN" }]]));
    expect(await screen.findByText("Snap, CNN")).toBeInTheDocument();
    expect(screen.getByText("snap-abc")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More actions for snap-abc" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename snap-abc" }));
    expect(screen.getByRole("textbox", { name: "Name for snap-abc" })).toHaveValue("Snap, CNN");
    fireEvent.change(screen.getByRole("textbox", { name: "Name for snap-abc" }), { target: { value: " " } });
    fireEvent.submit(screen.getByRole("textbox", { name: "Name for snap-abc" }));
    await waitFor(() => expect(calls("rename_label_model").at(-1)).toEqual(["rename_label_model", { id: "snap-abc", name: null }]));
  });

  it("leaves the name alone when renaming is cancelled or nothing changed", async () => {
    setup([{ ...draft, name: "Snap" }]);
    fireEvent.click(await screen.findByRole("button", { name: "More actions for snap-abc" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename snap-abc" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name for snap-abc" }), { target: { value: "Other" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name for snap-abc" }), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions for snap-abc" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename snap-abc" }));
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(calls("rename_label_model")).toEqual([]);
    expect(screen.getByText("Snap")).toBeInTheDocument();
  });

  it("marks a model that may only run in Monitor, and lets it be approved for Monitor", async () => {
    setup([{ ...draft, imported: false, deployable: false, monitorOnly: true, state: "evaluated" }]);
    expect(await screen.findByText("Monitor only")).toBeInTheDocument();
    expect(screen.getByText(/never starts a recipe, even in Live/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve for Monitor snap-abc" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Fine-tune/ })).toBeNull();
  });

  it("shows a warning under a label whose model is being given inputs it was never trained on, and not for another label", async () => {
    setup([{ ...draft, state: "active", active: true }, { ...draft, id: "fist-1", label: "fist", state: "active", active: true }], {
      inputWarnings: [{ label: "snap", modelId: "snap-abc", unfamiliarShare: 0.8, worst: [{ name: "ppg_z1000ms_d1_green_n8_mean", value: 5000, low: 90000, high: 210000 }] }],
    });
    const warning = await screen.findByRole("alert", { name: "Inputs outside training for snap-abc" });
    const snap = screen.getByRole("list", { name: "snap models" });
    expect(warning.compareDocumentPosition(snap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // under the label's name, above its models
    expect(screen.queryByRole("alert", { name: /fist-1/ })).toBeNull();
  });

  it("says so when there are no models and does nothing outside the desktop app", () => {
    cleanup();
    render(<Harness desktopAvailable={false} />);
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
    // The switch is disabled while the Live change finishes; wait for it before asking for Off.
    await waitFor(() => expect(within(group).getByRole("radio", { name: /Off/ })).not.toHaveAttribute("aria-disabled", "true"));
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

  it("offers delete only for an archived model, and asks before deleting for good", async () => {
    setup([{ ...draft, id: "snap-old", state: "archived" }, { ...draft, id: "snap-new", state: "approved" }]);
    expect(await screen.findByText("snap-new")).toBeInTheDocument();
    expect(screen.queryByText("snap-old")).toBeNull(); // archived versions are folded away
    fireEvent.click(screen.getByRole("button", { name: "Show 1 archived" }));
    expect(screen.getByText("snap-old")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete snap-new" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete snap-old" }));
    expect(calls("delete_label_model")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(calls("delete_label_model")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete snap-old" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete snap-old for good" }));
    await waitFor(() => expect(calls("delete_label_model")).toEqual([["delete_label_model", { id: "snap-old" }]]));
  });

  it("shows why a delete was refused", async () => {
    setup([{ ...draft, id: "snap-old", state: "archived" }]);
    fireEvent.click(await screen.findByRole("button", { name: "Show 1 archived" }));
    await screen.findByText("snap-old");
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "delete_label_model") throw "The model was removed, but its files could not be deleted";
      return command === "list_label_models" ? [{ ...draft, id: "snap-old", state: "archived" }] : baseStatus;
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete snap-old" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete snap-old for good" }));
    expect(await screen.findByText(/files could not be deleted/)).toBeInTheDocument();
  });
  it("warns when a label has no active model, and says what to do next", async () => {
    setup([{ ...draft, state: "approved" }, { ...draft, id: "fist-1", label: "fist", state: "active", active: true }]);
    expect(await screen.findByText("No active model")).toBeInTheDocument();
    expect(screen.getByText(/Nothing detects snap, so no recipe that uses it can start or end\. Activate an approved version below\./)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing detects fist/)).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Scoring 1 of 2 labels. Nothing acts on them.");
  });

  it("says nothing is scored when no label has an active model", async () => {
    setup([{ ...draft, state: "approved" }]);
    expect(await screen.findByRole("status")).toHaveTextContent("No label has an active model, so nothing is scored.");
  });

  it("shows each model's threshold and held-out results", async () => {
    setup([{ ...draft, state: "active", active: true, activation: 0.99, evaluation: { recall: 0.8246, falseActivationsPerHour: 0 } }]);
    const list = await screen.findByLabelText("snap-abc figures");
    expect(within(list).getByText("0.99")).toBeInTheDocument();
    expect(within(list).getByText("82%")).toBeInTheDocument();
    expect(within(list).getByText("0.0")).toBeInTheDocument();
  });

  it("puts the active model first and offers Swap in for another approved version", async () => {
    setup([{ ...draft, id: "snap-new", state: "approved" }, { ...draft, id: "snap-live", state: "active", active: true }]);
    const slot = await screen.findByRole("listitem", { name: "Active snap model" });
    expect(within(slot).getByText("snap-live")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Swap in snap-new" }));
    await waitFor(() => expect(calls("activate_label_model")).toEqual([["activate_label_model", { id: "snap-new" }]]));
  });

  it("keeps stepping back and archiving behind More", async () => {
    setup([{ ...draft, state: "approved" }]);
    await screen.findByRole("button", { name: "Activate snap-abc" });
    expect(screen.queryByRole("button", { name: "Archive snap-abc" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions for snap-abc" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive snap-abc" }));
    await waitFor(() => expect(calls("set_label_model_state")).toEqual([["set_label_model_state", { id: "snap-abc", state: "archived" }]]));
  });
});
