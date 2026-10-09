import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { CatalogueLabelPicker } from "./CatalogueLabelPicker";

const label = (id: string, displayName: string, archivedAt: string | null = null) => ({ id, displayName, description: "", color: "#65e6ff", role: "positiveGesture", archivedAt });
let labels = [label("pinch", "Pinch"), label("old", "Old", "2026-01-01")];

beforeEach(() => {
  labels = [label("pinch", "Pinch"), label("old", "Old", "2026-01-01")];
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args?: { input?: { id: string } }) => {
    if (command === "list_model_labels") return labels;
    if (command === "create_model_label") { labels = [...labels, label(args!.input!.id, args!.input!.id)]; return labels; }
    throw new Error(command);
  });
});
afterEach(() => cleanup());

describe("CatalogueLabelPicker", () => {
  it("offers the labels that are not archived and selects one", async () => {
    const onSelect = vi.fn().mockReturnValue(true);
    render(<CatalogueLabelPicker selectedLabel={null} onSelect={onSelect} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pinch" }));
    expect(onSelect).toHaveBeenCalledWith("pinch");
    expect(screen.queryByRole("button", { name: "Old" })).toBeNull();
  });

  it("says a typed label is not in Labels yet, and adds it", async () => {
    render(<CatalogueLabelPicker selectedLabel="wrist_flick" onSelect={vi.fn()} />);
    expect(await screen.findByText(/not in your Labels list/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to Labels" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_model_label", expect.objectContaining({ input: expect.objectContaining({ id: "wrist_flick" }) })));
    await waitFor(() => expect(screen.queryByText(/not in your Labels list/)).toBeNull());
  });
});
