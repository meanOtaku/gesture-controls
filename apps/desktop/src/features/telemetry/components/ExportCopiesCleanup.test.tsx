import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), message: vi.fn() }));
import type { CopyGroup, ExportCopy } from "../../../shared/tauri/exportCopies";
import { ExportCopiesCleanup } from "./ExportCopiesCleanup";

const copy = (name: string, modifiedMs: number, handLabelledRows = 0): ExportCopy => ({
  path: `/exports/${name}`,
  name,
  csvPath: null,
  signal: "s1",
  modifiedMs,
  exportedAtMs: null,
  relabelledAfterExport: null,
  ppgRows: 5,
  imuRows: 5,
  handLabelledRows,
  labels: ["pinch"],
  kind: "folder",
  exportedFrom: "recorder",
  nameTimeMs: null,
});
const groups: CopyGroup[] = [{ signal: "s1", copies: [copy("session-3", 3000, 9), copy("session-2", 2000), copy("session", 1000)], newestReason: "Newest because its files were changed last.", newestKnown: true }];

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("cleaning up copies in the export folder", () => {
  it("shows what it found, keeps the newest, and moves only the rest to the Trash once confirmed", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "scan_export_copies") return groups;
      if (command === "trash_export_copies") return { moved: ["/exports/session", "/exports/session-2"], error: null };
      return null;
    });
    render(<ExportCopiesCleanup folder="/exports" />);
    fireEvent.click(screen.getByRole("button", { name: "Find duplicate copies…" }));
    const found = await screen.findByRole("region", { name: "Copies of session-3" });
    expect(invoke).toHaveBeenCalledWith("scan_export_copies", { folder: "/exports", subfolders: false });
    expect(within(found).getByRole("radio", { name: "Keep session-3" })).toBeChecked();
    expect(within(found).getAllByText("to the Trash")).toHaveLength(2);
    expect(invoke).not.toHaveBeenCalledWith("trash_export_copies", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Move 2 copies to the Trash" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("trash_export_copies", { folder: "/exports", paths: ["/exports/session-2", "/exports/session"], subfolders: false }));
  });

  it("lets you keep another copy instead, and says the newest would go", async () => {
    invoke.mockImplementation(async (command: string) => (command === "scan_export_copies" ? groups : { moved: [], error: null }));
    render(<ExportCopiesCleanup folder="/exports" />);
    fireEvent.click(screen.getByRole("button", { name: "Find duplicate copies…" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Keep session" }));
    expect(screen.getByText(/You are keeping an older copy/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move 2 copies to the Trash" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("trash_export_copies", { folder: "/exports", paths: ["/exports/session-3", "/exports/session-2"], subfolders: false }));
  });

  it("chooses nothing where the newest cannot be told, and leaves that recording alone until you pick", async () => {
    const tied: CopyGroup[] = [
      ...groups,
      { signal: "s2", copies: [{ ...copy("pinch_in", 5000, 0), signal: "s2" }, { ...copy("pinch_hold", 5000, 3835), signal: "s2" }], newestReason: null, newestKnown: false },
    ];
    invoke.mockImplementation(async (command: string) => (command === "scan_export_copies" ? tied : { moved: [], error: null }));
    render(<ExportCopiesCleanup folder="/exports" />);
    fireEvent.click(screen.getByRole("button", { name: "Find duplicate copies…" }));
    const unclear = await screen.findByRole("region", { name: "Copies of pinch_in" });
    expect(within(unclear).getByText(/says which came later/)).toBeInTheDocument();
    expect(within(unclear).getByRole("radio", { name: "Keep pinch_in" })).not.toBeChecked();
    expect(within(unclear).getByRole("radio", { name: "Keep pinch_hold" })).not.toBeChecked();
    expect(screen.getByText(/1 recording needs you to choose/)).toBeInTheDocument();
    // Only the decided recording's older copies would go.
    expect(screen.getByRole("button", { name: "Move 2 copies to the Trash" })).toBeEnabled();
    fireEvent.click(within(unclear).getByRole("radio", { name: "Keep pinch_in" }));
    expect(within(unclear).getByText(/pinch_hold has more hand-labelled rows than the copy kept/)).toBeInTheDocument();
    fireEvent.click(within(unclear).getByRole("radio", { name: "Keep pinch_hold" }));
    fireEvent.click(screen.getByRole("button", { name: "Move 3 copies to the Trash" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("trash_export_copies", { folder: "/exports", paths: ["/exports/session-2", "/exports/session", "/exports/pinch_in"], subfolders: false }));
  });

  it("says so when there is nothing to clean up, and offers nothing to remove", async () => {
    invoke.mockResolvedValue([]);
    render(<ExportCopiesCleanup folder="/exports" />);
    fireEvent.click(screen.getByRole("button", { name: "Find duplicate copies…" }));
    expect(await screen.findByText("No recording has more than one copy here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move 0 copies to the Trash" })).toBeDisabled();
  });

  it("needs an export folder", () => {
    render(<ExportCopiesCleanup folder={null} />);
    expect(screen.getByRole("button", { name: "Find duplicate copies…" })).toBeDisabled();
  });
});
