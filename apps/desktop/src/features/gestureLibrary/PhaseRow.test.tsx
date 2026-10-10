import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatasetLabel } from "../model-lab/types";
import { PhaseRow } from "./PhaseRow";

afterEach(() => cleanup());

const label = (id: string, displayName: string, archivedAt: string | null = null): DatasetLabel => ({ id, displayName, description: "", color: "#65e6ff", role: "positiveGesture", archivedAt });

function setup(over: Partial<React.ComponentProps<typeof PhaseRow>> = {}) {
  const props: React.ComponentProps<typeof PhaseRow> = {
    what: "closing", spec: null, onChange: vi.fn(), labels: [label("pinch", "Pinch"), label("pinch_close", "Pinch closing"), label("old", "Old", "2026-01-01")],
    taken: ["pinch"], suggestedId: "pinch_close", suggestedName: "Pinch closing", onCreate: vi.fn().mockResolvedValue(null), ...over,
  };
  render(<PhaseRow {...props} />);
  return props;
}

describe("PhaseRow", () => {
  it("turns on with the suggested label when it exists, at 500 ms, and off again", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark the closing motion" }));
    expect(props.onChange).toHaveBeenCalledWith({ labelId: "pinch_close", ms: 500 });
  });

  it("offers one click to create the suggested label when it does not exist yet", async () => {
    const props = setup({ spec: { labelId: "", ms: 500 }, suggestedId: "wave_close", suggestedName: "Wave closing" });
    fireEvent.click(screen.getByRole("button", { name: "Create “wave_close”" }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledWith("wave_close", "Wave closing"));
    await waitFor(() => expect(props.onChange).toHaveBeenCalledWith({ labelId: "wave_close", ms: 500 }));
  });

  it("lists only labels that are not archived and not already used by the gesture, and passes on the length", () => {
    const props = setup({ spec: { labelId: "pinch_close", ms: 500 } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a label…", "Pinch closing"]);
    fireEvent.change(screen.getByLabelText("Length (ms)"), { target: { value: "800" } });
    expect(props.onChange).toHaveBeenCalledWith({ labelId: "pinch_close", ms: 800 });
  });

  it("shows the reason when the label cannot be created", async () => {
    setup({ spec: { labelId: "", ms: 500 }, suggestedId: "wave_close", suggestedName: "Wave closing", onCreate: vi.fn().mockResolvedValue("label 'wave_close' already exists") });
    fireEvent.click(screen.getByRole("button", { name: "Create “wave_close”" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  });
});
