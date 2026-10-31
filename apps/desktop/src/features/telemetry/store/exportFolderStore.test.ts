import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe("the shared export setting", () => {
  it("is a folder of two files with no folder at first, and is remembered between launches", async () => {
    const first = (await import("./exportFolderStore")).exportFolderStore;
    expect(first.get()).toBeNull();
    expect(first.getFormat()).toBe("folder");
    first.set("/Users/me/exports");
    first.setFormat("csv");
    vi.resetModules();
    const relaunched = (await import("./exportFolderStore")).exportFolderStore;
    expect(relaunched.get()).toBe("/Users/me/exports");
    expect(relaunched.getFormat()).toBe("csv");
    relaunched.reset();
    vi.resetModules();
    const cleared = (await import("./exportFolderStore")).exportFolderStore;
    expect(cleared.get()).toBeNull();
    expect(cleared.getFormat()).toBe("folder");
  });
});
