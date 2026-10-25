import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
// Undo on a message: the latest one's, to press in a test.
const undo = vi.hoisted(() => ({ last: null as null | (() => void) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn((_t: string, options?: { action?: { onClick: () => void } }) => { undo.last = options?.action?.onClick ?? null; }), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }) }));
import { UNDO_MS } from "../../../components/app/OperationFeedback";
import type { DatasetSummary } from "../types";
import { DatasetManager } from "./DatasetManager";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Lets the undo window pass, after which a delete goes ahead. */
const letUndoPass = () => act(() => vi.advanceTimersByTime(UNDO_MS));

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
    expect(screen.getByText(/pinch start · 42 rows/)).toBeInTheDocument();
    expect(screen.queryByText(/training role/i)).not.toBeInTheDocument();
  });

  it("numbers each recording by when it was imported", () => {
    setup({ datasets: [{ ...dataset, id: "d1", originalFilename: "first.csv", sequence: 1, importedAt: "2026-10-01T09:30:00Z" }, { ...dataset, id: "d4", originalFilename: "fourth.csv", sequence: 4 }] });
    expect(screen.getByLabelText("Recording 1")).toHaveTextContent("#1");
    expect(screen.getByLabelText("Recording 4")).toHaveTextContent("#4");
    expect(screen.getByText(/imported 2026-10-01 09:30/)).toBeInTheDocument();
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const props = setup({ error: "unknown label 'x'" });
    expect(screen.getByRole("alert")).toHaveTextContent("unknown label 'x' Nothing was imported");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Keep it" }));
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const buttons = await screen.findAllByRole("button", { name: "Delete" });
    fireEvent.click(buttons[buttons.length - 1]);
    // It waits, with Undo, before deleting; the recording is hidden meanwhile.
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText("session-1.csv")).toBeNull();
    letUndoPass();
    expect(props.onDelete).toHaveBeenCalledWith("d1");
  });

  const gaps = (share: number, count: number) => ({ samples: 500, durationS: 30, rateHz: 25, gaps: count, longestGapS: 4.6, shareInGaps: share });

  it("imports a recording folder as the main way, keeps the single CSV as an older-format choice, and shows how dense each stream is", () => {
    const onImportFolder = vi.fn().mockResolvedValue(undefined);
    setup({
      onImportFolder,
      datasets: [
        { ...dataset, id: "a", originalFilename: "steady", twoFiles: true, gaps: { ppg: gaps(0, 0), imu: gaps(0, 0) } },
        { ...dataset, id: "b", originalFilename: "stalled", twoFiles: true, gaps: { ppg: gaps(0.4, 15), imu: gaps(0.4, 15) } },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Import a recording folder" }));
    expect(onImportFolder).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Import a single CSV (older format)" })).toBeInTheDocument();
    expect(screen.getByText(/pulse steady at 25 Hz · motion steady at 25 Hz/)).toBeInTheDocument();
    expect(screen.getByText(/Watch stream stalled: pulse: 15 stalls, longest 4.6 s, 40% of the time/)).toBeInTheDocument();
    expect(screen.getAllByText(/two files/)).toHaveLength(2);
  });

  it("offers to convert recordings in the older format, says what happened to each, and reloads", async () => {
    const onConverted = vi.fn();
    invokeMock.mockResolvedValue([
      { id: "old", originalFilename: "old.csv", outcome: "converted", message: "now two dense files" },
      { id: "bad", originalFilename: "bad.csv", outcome: "failed", message: "the split did not keep every row" },
    ]);
    setup({ onConverted, datasets: [{ ...dataset, id: "old", originalFilename: "old.csv" }, { ...dataset, id: "new", originalFilename: "new", twoFiles: true }] });
    const group = screen.getByRole("group", { name: "Older recordings" });
    expect(group).toHaveTextContent("1 recording is in the older single-file format");
    fireEvent.click(within(group).getByRole("button", { name: "Convert to two files" }));
    const results = await screen.findByRole("list", { name: "Conversion results" });
    expect(results).toHaveTextContent("old.csv: converted");
    expect(results).toHaveTextContent("bad.csv: left as it was. the split did not keep every row");
    await waitFor(() => expect(onConverted).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledWith("convert_datasets_to_folders");
  });

  it("says nothing about converting when every recording is already two files", () => {
    setup({ datasets: [{ ...dataset, twoFiles: true }] });
    expect(screen.queryByRole("group", { name: "Older recordings" })).toBeNull();
  });

  const quality = (poor: number) => ({ poorContactShare: poor, holds: { pinch: 5 }, shortHolds: 0 });

  it("finds recordings by words and what is wrong, and acts on the chosen ones together", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onSeal = vi.fn().mockResolvedValue(undefined);
    const props = setup({
      onSeal,
      datasets: [
        { ...dataset, id: "a", sequence: 1, originalFilename: "monday", contentSha: "1", quality: quality(0) },
        { ...dataset, id: "b", sequence: 2, originalFilename: "tuesday", contentSha: "2", quality: quality(0.4) },
        { ...dataset, id: "c", sequence: 3, originalFilename: "wednesday", contentSha: "3", quality: quality(0) },
      ],
    });
    const list = screen.getByRole("list", { name: "Imported recordings" });
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "problems" } });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("tuesday")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Search recordings"), { target: { value: "day" } });
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search recordings"), { target: { value: "wed" } });
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search recordings"), { target: { value: "" } });

    fireEvent.click(screen.getByRole("checkbox", { name: "Choose monday" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Choose wednesday" }));
    const bulk = screen.getByRole("group", { name: "With the chosen recordings" });
    expect(bulk).toHaveTextContent("2 chosen");
    fireEvent.click(within(bulk).getByRole("button", { name: "Seal" }));
    expect(onSeal).toHaveBeenCalledWith(["a", "c"], true);
    fireEvent.click(within(bulk).getByRole("button", { name: "Delete" }));
    await screen.findByRole("alertdialog");
    // The dialog's Delete comes last.
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    letUndoPass();
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledTimes(2));
    expect(props.onDelete).toHaveBeenNthCalledWith(1, "a");
    expect(props.onDelete).toHaveBeenNthCalledWith(2, "c");
  });

  it("offers to keep one of each set of copies", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const props = setup({
      datasets: [
        { ...dataset, id: "a", sequence: 1, originalFilename: "first", contentSha: "same" },
        { ...dataset, id: "b", sequence: 2, originalFilename: "copy", contentSha: "same" },
      ],
    });
    const group = screen.getByRole("group", { name: "Copies" });
    expect(group).toHaveTextContent("1 copy of other recordings");
    fireEvent.click(within(group).getByRole("button", { name: "Keep one of each (delete 1)" }));
    const confirm = await screen.findAllByRole("button", { name: "Delete" });
    fireEvent.click(confirm.at(-1)!);
    letUndoPass();
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith("b"));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("takes a delete back with Undo before it happens", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const buttons = await screen.findAllByRole("button", { name: "Delete" });
    fireEvent.click(buttons.at(-1)!);
    expect(screen.queryByText("session-1.csv")).toBeNull();
    act(() => undo.last?.());
    expect(screen.getByText("session-1.csv")).toBeInTheDocument();
    letUndoPass();
    expect(props.onDelete).not.toHaveBeenCalled();
  });
});
