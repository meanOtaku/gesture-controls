import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportCsv } from "./exportCsv";

const { save, writeTextFile } = vi.hoisted(() => ({
  save: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile }));

function setDesktop(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  } else {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
}

beforeEach(() => {
  save.mockReset();
  writeTextFile.mockReset();
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
