import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatasetManager } from "./DatasetManager";
import { TooltipProvider } from "../../../components/ui/tooltip";
import type { DatasetSummary } from "../types";

afterEach(() => cleanup());

const DATASET_A: DatasetSummary = {
  id: "dataset-a",
  originalFilename: "session-1.csv",
  importedAt: "2026-08-31T00:00:00Z",
  label: "pinch_start",
  rowCount: 42,
};

function renderManager(overrides: Partial<React.ComponentProps<typeof DatasetManager>> = {}) {
  const props: React.ComponentProps<typeof DatasetManager> = {
    desktopAvailable: true,
    datasets: [],
    labels: [],
    loading: false,
    importing: false,
    error: null,
    selectedDatasetIds: new Set(),
    pendingDeleteIds: new Set(),
    coverageByLabel: new Map(),
    onImport: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onToggleSelected: vi.fn(),
    ...overrides,
  };
  render(<TooltipProvider><DatasetManager {...props} /></TooltipProvider>);
  return props;
}

describe("DatasetManager", () => {
  it("exposes Dataset and Label coverage as separate accessible regions", () => {
    renderManager();
    expect(screen.getByRole("region", { name: "Dataset" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Label coverage" })).toBeInTheDocument();
  });

  it("disables import outside the desktop app", () => {
    renderManager({ desktopAvailable: false });
    expect(screen.getByRole("button", { name: "Import dataset CSV" })).toBeDisabled();
  });

  it("imports a selected CSV file via the hidden file input", async () => {
    const onImport = vi.fn().mockResolvedValue(undefined);
    renderManager({ onImport });

    const file = new File(["# label: pinch_start\ncsv,content"], "session-1.csv", { type: "text/csv" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() =>
      expect(onImport).toHaveBeenCalledWith({ filename: "session-1.csv", csvContent: "# label: pinch_start\ncsv,content" }),
    );
  });

  it("shows an inline error and the empty state when there are no datasets", () => {
    renderManager({ error: "disk unavailable" });
    expect(screen.getByRole("alert")).toHaveTextContent(/disk unavailable/i);
    expect(screen.getByText(/no dataset sessions imported yet/i)).toBeInTheDocument();
  });

  it("lists a dataset with its label and row count, and toggles selection", () => {
    const onToggleSelected = vi.fn();
    renderManager({ datasets: [DATASET_A], onToggleSelected });
    expect(screen.getByText(/session-1\.csv.*pinch start.*42 rows/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select session-1.csv" }));
    expect(onToggleSelected).toHaveBeenCalledWith("dataset-a");
  });

  it("requires confirmation before deleting a dataset, and does not delete on cancel", () => {
    const onDelete = vi.fn();
    renderManager({ datasets: [DATASET_A], onDelete });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete this dataset session?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep session" }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("deletes the dataset once confirmed", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    renderManager({ datasets: [DATASET_A], onDelete });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmButtons = await screen.findAllByRole("button", { name: "Delete" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("dataset-a"));
  });

  it("derives label coverage counts and shows built-in and custom labels", () => {
    const coverageByLabel = new Map([["pinch_start", 1]]);
    renderManager({
      coverageByLabel,
      labels: [
        { id: "wrist_flick", displayName: "Wrist flick", description: "", color: "#fff", role: "positiveGesture", archivedAt: null },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /view label coverage/i }));
    const pinchStartRow = screen.getByText("pinch start").closest(".model-lab-label-row");
    expect(pinchStartRow).toHaveTextContent("1 session");
    const idleRow = screen.getByText("idle").closest(".model-lab-label-row");
    expect(idleRow).toHaveTextContent("0 sessions");
    expect(screen.getByText("Wrist flick")).toBeInTheDocument();
  });
});
