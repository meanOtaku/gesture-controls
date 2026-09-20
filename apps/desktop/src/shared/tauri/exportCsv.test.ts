import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseExportFolder, exportCsv, exportCsvToFolder } from "./exportCsv";

const { open, save, writeTextFile, join } = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
  writeTextFile: vi.fn(),
  join: vi.fn((...parts: string[]) => parts.join("/")),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open, save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile }));
vi.mock("@tauri-apps/api/path", () => ({ join }));

function setDesktop(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  } else {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
}

beforeEach(() => {
  open.mockReset();
  save.mockReset();
  writeTextFile.mockReset();
  join.mockReset();
  join.mockImplementation((...parts: string[]) => parts.join("/"));
});

afterEach(() => {
  setDesktop(false);
});

describe("exportCsv", () => {
  it("writes the exact content to the user-selected path when saved in Tauri", async () => {
    setDesktop(true);
    save.mockResolvedValue("/Users/test/Desktop/gesture-dataset.csv");
    writeTextFile.mockResolvedValue(undefined);

    const result = await exportCsv({ content: "a,b\n1,2", suggestedName: "gesture-dataset.csv", title: "Export dataset" });

    expect(result).toEqual({ status: "saved", path: "/Users/test/Desktop/gesture-dataset.csv" });
    expect(save).toHaveBeenCalledWith({
      title: "Export dataset",
      defaultPath: "gesture-dataset.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    expect(writeTextFile).toHaveBeenCalledWith("/Users/test/Desktop/gesture-dataset.csv", "a,b\n1,2");
  });

  it("reports cancellation without writing when the user dismisses the dialog", async () => {
    setDesktop(true);
    save.mockResolvedValue(null);

    const result = await exportCsv({ content: "a,b\n1,2", suggestedName: "gesture-dataset.csv", title: "Export dataset" });

    expect(result).toEqual({ status: "cancelled" });
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("reports a typed error instead of throwing when the write fails", async () => {
    setDesktop(true);
    save.mockResolvedValue("/root/forbidden.csv");
    writeTextFile.mockRejectedValue(new Error("permission denied"));

    const result = await exportCsv({ content: "a,b\n1,2", suggestedName: "gesture-dataset.csv", title: "Export dataset" });

    expect(result).toEqual({ status: "error", message: "permission denied" });
  });

  it("reports a typed error instead of throwing when the dialog itself fails", async () => {
    setDesktop(true);
    save.mockRejectedValue(new Error("dialog unavailable"));

    const result = await exportCsv({ content: "a,b\n1,2", suggestedName: "gesture-dataset.csv", title: "Export dataset" });

    expect(result).toEqual({ status: "error", message: "dialog unavailable" });
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("falls back to a revoked Blob-anchor download in browser preview", async () => {
    setDesktop(false);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

    const result = await exportCsv({ content: "a,b\n1,2", suggestedName: "gesture-dataset.csv", title: "Export dataset" });

    expect(result).toEqual({ status: "saved", path: "gesture-dataset.csv" });
    expect(save).not.toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");

    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("chooseExportFolder", () => {
  it("returns the chosen folder path in Tauri", async () => {
    setDesktop(true);
    open.mockResolvedValue("/Users/test/datasets");

    const folder = await chooseExportFolder("Choose folder");

    expect(folder).toBe("/Users/test/datasets");
    expect(open).toHaveBeenCalledWith({ title: "Choose folder", directory: true, multiple: false });
  });

  it("returns null when the user cancels the folder picker", async () => {
    setDesktop(true);
    open.mockResolvedValue(null);

    expect(await chooseExportFolder("Choose folder")).toBeNull();
  });

  it("returns null in browser preview, where there is no native folder picker", async () => {
    setDesktop(false);
    expect(await chooseExportFolder("Choose folder")).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("exportCsvToFolder", () => {
  it("writes directly into the chosen folder under the generated file name, with no dialog", async () => {
    setDesktop(true);
    writeTextFile.mockResolvedValue(undefined);

    const result = await exportCsvToFolder({ content: "a,b\n1,2", folder: "/Users/test/datasets", fileName: "gesture-dataset.csv" });

    expect(result).toEqual({ status: "saved", path: "/Users/test/datasets/gesture-dataset.csv" });
    expect(save).not.toHaveBeenCalled();
    expect(writeTextFile).toHaveBeenCalledWith("/Users/test/datasets/gesture-dataset.csv", "a,b\n1,2");
  });

  it("reports a typed error instead of throwing when the write fails", async () => {
    setDesktop(true);
    writeTextFile.mockRejectedValue(new Error("permission denied"));

    const result = await exportCsvToFolder({ content: "a,b\n1,2", folder: "/root", fileName: "gesture-dataset.csv" });

    expect(result).toEqual({ status: "error", message: "permission denied" });
  });

  it("falls back to a Blob-anchor download in browser preview instead of requiring a folder", async () => {
    setDesktop(false);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

    const result = await exportCsvToFolder({ content: "a,b\n1,2", folder: "", fileName: "gesture-dataset.csv" });

    expect(result).toEqual({ status: "saved", path: "gesture-dataset.csv" });
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalledTimes(1);

    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
