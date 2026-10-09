import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LabelModel } from "../labelModels";
import type { DatasetLabel } from "../types";
import { LabelCoverage } from "./LabelCoverage";

afterEach(cleanup);

const label = (id: string, displayName: string, archivedAt: string | null = null): DatasetLabel => ({ id, displayName, description: "", color: "#65e6ff", role: "positiveGesture", archivedAt });
const model = (labelId: string, state: LabelModel["state"]): LabelModel => ({
  id: `${labelId}-1`, label: labelId, state, deployable: true, imported: true, modelSha256: null, createdAt: "2026-10-01", active: state === "active",
});

function setup(over: Partial<React.ComponentProps<typeof LabelCoverage>> = {}) {
  const props: React.ComponentProps<typeof LabelCoverage> = {
    labels: [], models: [], coverageByLabel: new Map(),
    onCreate: vi.fn().mockResolvedValue(null), onSetArchived: vi.fn().mockResolvedValue(undefined), onDelete: vi.fn().mockResolvedValue(null), ...over,
  };
  render(<LabelCoverage {...props} />);
  return props;
}

describe("LabelCoverage", () => {
  it("starts with no labels at all and explains what one is", () => {
    setup();
    expect(screen.getByText(/No labels yet/)).toBeInTheDocument();
    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
  });

  it("shows each label's recordings and model state, flagging a single recording", () => {
    setup({ labels: [label("idle", "Idle"), label("snap", "Snap")], models: [model("snap", "active")], coverageByLabel: new Map([["idle", 3], ["snap", 1]]) });
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(rows[0]).toContain("3 recordings");
    expect(rows[0]).toContain("No model");
    expect(rows[1]).toContain("record at least one more");
    expect(rows[1]).toContain("Model: active");
  });

  it("adds a label from a typed name, showing the id it will get", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /Add a label/ }));
    const form = within(screen.getByRole("form", { name: "New label" }));
    expect(form.getByRole("button", { name: "Create label" })).toBeDisabled();
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "Snap fingers" } });
    expect(form.getByText(/Its id will be snap_fingers/)).toBeInTheDocument();
    fireEvent.change(form.getByLabelText("What is it?"), { target: { value: "negativeBackground" } });
    fireEvent.change(form.getByLabelText("Notes (optional)"), { target: { value: "thumb and middle finger" } });
    fireEvent.click(form.getByRole("button", { name: "Create label" }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledWith({ id: "snap_fingers", displayName: "Snap fingers", description: "thumb and middle finger", role: "negativeBackground" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "New label" })).not.toBeInTheDocument());
  });

  it("refuses a duplicate or empty id before asking, and shows the backend's refusal", async () => {
    const props = setup({ labels: [label("snap", "Snap")], onCreate: vi.fn().mockResolvedValue("no space left") });
    fireEvent.click(screen.getByRole("button", { name: /Add a label/ }));
    const form = within(screen.getByRole("form", { name: "New label" }));
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "SNAP" } });
    expect(form.getByRole("alert")).toHaveTextContent("already exists");
    expect(form.getByRole("button", { name: "Create label" })).toBeDisabled();
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "!!!" } });
    expect(form.getByRole("alert")).toHaveTextContent("letters or digits");
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "wave" } });
    fireEvent.click(form.getByRole("button", { name: "Create label" }));
    expect(await form.findByText("no space left")).toBeInTheDocument();
    expect(props.onCreate).toHaveBeenCalledTimes(1);
  });

  it("archives and restores, hiding archived labels until asked", () => {
    const props = setup({ labels: [label("snap", "Snap"), label("old", "Old", "2026-09-01")] });
    expect(screen.queryByText("Old")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive snap" }));
    expect(props.onSetArchived).toHaveBeenCalledWith("snap", true);
    fireEvent.click(screen.getByRole("button", { name: "Show 1 archived label" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore old" }));
    expect(props.onSetArchived).toHaveBeenCalledWith("old", false);
  });

  it("offers delete only for a label nothing uses, and asks first", async () => {
    const props = setup({ labels: [label("spare", "Spare"), label("snap", "Snap")], models: [model("snap", "draft")], coverageByLabel: new Map() });
    expect(screen.queryByRole("button", { name: "Delete snap" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete spare" }));
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete spare" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete spare", hidden: false }) as HTMLElement);
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith("spare"));
  });

  it("shows the reason when a delete is refused, and lists a label only a model refers to", async () => {
    setup({ labels: [label("spare", "Spare")], models: [model("wave", "draft")], onDelete: vi.fn().mockResolvedValue("it is used") });
    expect(screen.getByText("wave")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete spare" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete spare" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("it is used");
  });

  it("marks the required fields, and edits a label's name, notes and role without touching its id", async () => {
    const onUpdate = vi.fn().mockResolvedValue(null);
    setup({ labels: [label("pinch", "Pinch")], onUpdate, gestureCountByLabel: new Map([["pinch", 2]]) });
    expect(screen.getByRole("listitem").textContent).toContain("2 gestures");
    fireEvent.click(screen.getByRole("button", { name: "Edit pinch" }));
    const form = within(screen.getByRole("form", { name: "Edit pinch" }));
    expect(form.getByText("Name")).toHaveAttribute("data-required", "true");
    expect(form.getByText("Notes (optional)")).not.toHaveAttribute("data-required");
    fireEvent.change(form.getByLabelText("Name"), { target: { value: "Index pinch" } });
    fireEvent.change(form.getByLabelText("Notes (optional)"), { target: { value: "thumb to index" } });
    fireEvent.click(form.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ id: "pinch", displayName: "Index pinch", description: "thumb to index", role: "positiveGesture" }));
  });

  it("will not delete a label a gesture still uses, and does not offer to", () => {
    setup({ labels: [label("pinch", "Pinch")], gestureCountByLabel: new Map([["pinch", 1]]) });
    expect(screen.queryByRole("button", { name: "Delete pinch" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive pinch" })).toBeInTheDocument();
  });
});
