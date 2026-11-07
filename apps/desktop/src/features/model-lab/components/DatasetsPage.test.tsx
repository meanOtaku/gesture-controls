import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatasetsPage } from "./DatasetsPage";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

let datasets = [{ id: "d1", originalFilename: "a.csv", importedAt: "", label: "pinch_in", rowCount: 10, sequence: 1 }];

beforeEach(() => {
  invokeMock.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invokeMock.mockImplementation(async (command: string, args?: { id: string; name: string | null }) => {
    switch (command) {
      case "list_model_datasets": return datasets;
      case "list_model_labels": return [];
      case "list_recording_bundles": return [];
      case "set_dataset_name":
        datasets = datasets.map((d) => (d.id === args!.id ? { ...d, name: args!.name ?? undefined } : d));
        return datasets;
      default: return undefined;
    }
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("DatasetsPage", () => {
  it("keeps every recording in one place, where it is named for every other tab", async () => {
    render(<DatasetsPage />);
    expect(screen.getByRole("heading", { name: "Datasets" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Recordings from the Recorder" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Rename #1 a.csv" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name of a.csv" }), { target: { value: "Monday pinches" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("set_dataset_name", { id: "d1", name: "Monday pinches" }));
    const list = await screen.findByRole("list", { name: "Imported recordings" });
    await waitFor(() => expect(within(list).getByText("Monday pinches")).toBeInTheDocument());
  });
});
