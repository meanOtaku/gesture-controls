import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const openDialog = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => openDialog(...args), message: vi.fn() }));
import type { CopyGroup, ExportCopy } from "../../shared/tauri/exportCopies";
import { exportFolderStore } from "../telemetry/store/exportFolderStore";
import { DuplicatesPage } from "./DuplicatesPage";

const copy = (name: string, modifiedMs: number, extra: Partial<ExportCopy> = {}): ExportCopy => ({
  path: `/data/${name}`,
  name,
  csvPath: null,
  signal: "s1",
  modifiedMs,
  exportedAtMs: null,
  relabelledAfterExport: null,
  ppgRows: 5,
  imuRows: 5,
  handLabelledRows: 0,
  labels: ["pinch"],
  kind: "folder",
  exportedFrom: "recorder",
  nameTimeMs: null,
  ...extra,
});
const found: CopyGroup[] = [
  { signal: "s1", copies: [copy("Hand labeled/session", 3000, { handLabelledRows: 40 }), copy("old/session.csv", 1000, { kind: "csv" })], newestReason: "Newest because its files were changed last.", newestKnown: true },
  { signal: "s2", copies: [copy("Hand labeled/pinch_in", 2000, { signal: "s2" }), copy("Hand labeled/pinch_hold", 2000, { signal: "s2", handLabelledRows: 3835 })], newestReason: null, newestKnown: false },
];

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  exportFolderStore.set("/data");
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  openDialog.mockReset();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("the Duplicates tab", () => {
  it("scans the export folder with its subfolders, shows what it found, and moves only what you confirm", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "scan_export_copies") return found;
      if (command === "trash_export_copies") return { moved: ["/data/old/session.csv"], error: null };
      return null;
    });
    render(<DuplicatesPage />);
    expect(screen.getByText("/data")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("region", { name: "Copies of Hand labeled/session" });
    expect(invoke).toHaveBeenCalledWith("scan_export_copies", { folder: "/data", subfolders: true });
    expect(screen.getByText("2 recordings have copies: 2 older copies.")).toBeInTheDocument();
    expect(screen.getByText(/in different folders \(Hand labeled, old\)/)).toBeInTheDocument();
    expect(screen.getByText(/1 recording needs you to choose/)).toBeInTheDocument();
    expect(screen.getByText("session: Newest because its files were changed last.")).toBeInTheDocument();
    expect(screen.getAllByText(/exported from the Recorder/).length).toBeGreaterThan(0);
    // Only the decided recording's older copy would go, and only once confirmed.
    fireEvent.click(screen.getByRole("button", { name: "Move 1 copy to the Trash" }));
    expect(invoke).not.toHaveBeenCalledWith("trash_export_copies", expect.anything());
    const confirm = await screen.findByRole("alertdialog");
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Move to the Trash" })));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("trash_export_copies", { folder: "/data", paths: ["/data/old/session.csv"], subfolders: true }));
    // The folder is scanned again after.
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "scan_export_copies")).toHaveLength(2));
  });

  it("scans a folder you choose, only that folder when subfolders are left out", async () => {
    invoke.mockResolvedValue([]);
    openDialog.mockResolvedValue("/elsewhere");
    render(<DuplicatesPage />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Change…" })));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include subfolders" }));
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByText("No recording has more than one copy here.")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("scan_export_copies", { folder: "/elsewhere", subfolders: false });
    expect(screen.queryByRole("button", { name: /to the Trash/ })).toBeNull();
  });

  it("shows why a scan failed", async () => {
    invoke.mockRejectedValue("that folder holds the app's own data: choose an export folder");
    render(<DuplicatesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("app's own data");
  });
});
