import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatasetSummary } from "../types";
import { DatasetManager } from "./DatasetManager";

afterEach(cleanup);

const dataset: DatasetSummary = { id: "d1", originalFilename: "session-1.csv", importedAt: "2026-10-01", label: "pinch_start", rowCount: 42 };

function setup(over: Partial<React.ComponentProps<typeof DatasetManager>> = {}) {
  const props: React.ComponentProps<typeof DatasetManager> = {
    desktopAvailable: true, datasets: [dataset], loading: false, importing: false, error: null, pendingDeleteIds: new Set(),
    onImport: vi.fn().mockResolvedValue(undefined), onDelete: vi.fn().mockResolvedValue(undefined), ...over,
  };
  render(<DatasetManager {...props} />);
  return props;
}

describe("DatasetManager", () => {
  it("lists recordings plainly, with no training-role or selection leftovers", () => {
    setup();
    expect(screen.getByText("session-1.csv")).toBeInTheDocument();
    expect(screen.getByText("pinch start · 42 rows")).toBeInTheDocument();
    expect(screen.queryByText(/training role/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("imports a chosen CSV", async () => {
    const props = setup({ datasets: [] });
    expect(screen.getByText("No recordings imported yet.")).toBeInTheDocument();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["a,b\n1,2"], "new.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });
    await vi.waitFor(() => expect(props.onImport).toHaveBeenCalledWith({ filename: "new.csv", csvContent: "a,b\n1,2" }));
  });

  it("asks before deleting, and shows an import failure with its cause", async () => {
    const props = setup({ error: "unknown label 'x'" });
    expect(screen.getByRole("alert")).toHaveTextContent("unknown label 'x' Nothing was imported");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Keep it" }));
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const buttons = await screen.findAllByRole("button", { name: "Delete" });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(props.onDelete).toHaveBeenCalledWith("d1");
  });
});
