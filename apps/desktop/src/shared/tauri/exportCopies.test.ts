import { afterEach, describe, expect, it, vi } from "vitest";

const { message } = vi.hoisted(() => ({ message: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { askAboutEarlierCopies, exportReplacingEarlierCopies, replacedLine, type ExportCopy, type ExportOutcome } from "./exportCopies";

const copy: ExportCopy = {
  path: "/exports/session",
  name: "session",
  csvPath: null,
  signal: "abc",
  modifiedMs: 1_700_000_000_000,
  exportedAtMs: 1_600_000_000_000,
  relabelledAfterExport: true,
  ppgRows: 10,
  imuRows: 20,
  handLabelledRows: 12,
  labels: ["pinch"],
  kind: "folder",
  exportedFrom: "recorder",
  nameTimeMs: null,
};
const written = (path: string, replaced: string[] = []): ExportOutcome => ({ written: path, replaced, needsChoice: [], warning: null });

afterEach(() => message.mockReset());

describe("exporting a recording that is already in the folder", () => {
  it("replaces the earlier copy without asking when it holds nothing newer", async () => {
    const run = vi.fn().mockResolvedValue(written("/exports/session-2", ["/exports/session"]));
    const ask = vi.fn();
    const outcome = await exportReplacingEarlierCopies(run, ask);
    expect(outcome?.written).toBe("/exports/session-2");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(undefined);
    expect(ask).not.toHaveBeenCalled();
    expect(replacedLine(outcome!)).toBe(" Replaced the earlier copy (session), now in the Trash.");
  });

  it("asks when an earlier copy may hold newer hand labels, and exports as the answer says", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ written: null, replaced: [], needsChoice: [copy], warning: null })
      .mockResolvedValueOnce(written("/exports/session-2"));
    const outcome = await exportReplacingEarlierCopies(run, async () => "keepBoth");
    expect(run).toHaveBeenNthCalledWith(2, "keepBoth");
    expect(outcome?.written).toBe("/exports/session-2");
  });

  it("writes nothing when the person cancels", async () => {
    const run = vi.fn().mockResolvedValue({ written: null, replaced: [], needsChoice: [copy], warning: null });
    expect(await exportReplacingEarlierCopies(run, async () => null)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("still reads a bare path, as exports returned before", async () => {
    const outcome = await exportReplacingEarlierCopies(async () => "/exports/x");
    expect(outcome).toEqual(written("/exports/x"));
    expect(replacedLine(outcome!)).toBe("");
  });

  it("counts a single-CSV copy's CSV and folder as one copy", () => {
    expect(replacedLine(written("/e/b.csv", ["/e/a-files", "/e/a.csv", "/e/c-files"]))).toBe(" Replaced 2 earlier copies, now in the Trash.");
  });

  it("asks with Replace, Keep both and Cancel, naming the copy and its hand labels", async () => {
    message.mockResolvedValueOnce("Replace").mockResolvedValueOnce("Keep both").mockResolvedValueOnce("Cancel");
    expect(await askAboutEarlierCopies([copy])).toBe("replace");
    expect(await askAboutEarlierCopies([copy])).toBe("keepBoth");
    expect(await askAboutEarlierCopies([copy])).toBeNull();
    const [text, options] = message.mock.calls[0];
    expect(text).toContain("session: 12 hand-labelled rows");
    expect(text).toContain("labels changed after it was exported");
    expect(options.buttons).toEqual({ yes: "Replace", no: "Keep both", cancel: "Cancel" });
  });
});
