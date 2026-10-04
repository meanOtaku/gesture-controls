import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LabelModel } from "../labelModels";
import type { DatasetLabel } from "../types";
import { LabelCoverage } from "./LabelCoverage";

afterEach(cleanup);

const label = (id: string, displayName: string): DatasetLabel => ({ id, displayName, description: "", color: "", role: "positiveGesture", archivedAt: null });
const model = (labelId: string, state: LabelModel["state"]): LabelModel => ({
  id: `${labelId}-1`, label: labelId, state, deployable: true, imported: true, modelSha256: null, createdAt: "2026-10-01", active: state === "active",
});

describe("LabelCoverage", () => {
  const labels = [label("idle", "Idle"), label("snap", "Snap"), label("unused_one", "Unused one")];

  it("shows recordings and model state per label, hiding labels with neither until asked", () => {
    render(<LabelCoverage labels={labels} models={[model("snap", "active")]} coverageByLabel={new Map([["idle", 3], ["snap", 1]])} />);
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("3 recordings");
    expect(rows[0]).toContain("No model");
    expect(rows[1]).toContain("1 recording");
    expect(rows[1]).toContain("record at least one more");
    expect(rows[1]).toContain("Model: active");
    expect(screen.queryByText("Unused one")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 unused label" }));
    expect(screen.getByText("Unused one")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide unused labels" }));
    expect(screen.queryByText("Unused one")).not.toBeInTheDocument();
  });

  it("includes a label that only has a model, and says so when nothing is in use", () => {
    const { unmount } = render(<LabelCoverage labels={[]} models={[model("wave", "draft")]} coverageByLabel={new Map()} />);
    expect(screen.getByText("Model: draft")).toBeInTheDocument();
    unmount();
    render(<LabelCoverage labels={[]} models={[]} coverageByLabel={new Map()} />);
    expect(screen.getByText(/No labels in use yet/)).toBeInTheDocument();
  });
});
