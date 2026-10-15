import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRT_STORAGE_KEY, THEME_STORAGE_KEY, applyCrt, applyTheme, readCrt, readTheme, saveCrt, saveTheme } from "./theme";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.head.insertAdjacentHTML("beforeend", '<meta name="theme-color" content="#000066" />');
});
afterEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((node) => node.remove());
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("theme", () => {
  it("is neo-brutalism until another is chosen, and ignores anything it does not know", () => {
    expect(readTheme()).toBe("neo");
    window.localStorage.setItem(THEME_STORAGE_KEY, "rainbow");
    expect(readTheme()).toBe("neo");
    window.localStorage.setItem(THEME_STORAGE_KEY, "electric");
    expect(readTheme()).toBe("electric");
  });

  it("marks the page for the chosen theme and clears the mark for the original", () => {
    expect(applyTheme("neo")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("neo");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#fbf3e4");
    applyTheme("electric");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#000066");
  });

  it("remembers the choice, including a return to the original look", () => {
    saveTheme("electric");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("electric");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    saveTheme("neo");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("neo");
    expect(document.documentElement.getAttribute("data-theme")).toBe("neo");
  });

  it("never themes the floating volume knob's window, even though the page starts marked for neo", () => {
    document.documentElement.setAttribute("data-theme", "neo");
    window.history.replaceState(null, "", "/?window=overlay");
    expect(applyTheme("neo")).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("still works when the browser will not remember", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readTheme()).toBe("neo");
    expect(() => saveTheme("electric")).not.toThrow();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("the halftone theme", () => {
  it("is a theme that can be saved, read back and put on the page", () => {
    saveTheme("halftone");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("halftone");
    expect(readTheme()).toBe("halftone");
    expect(document.documentElement.getAttribute("data-theme")).toBe("halftone");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#080808");
  });
  it("is left off the floating volume knob's window like the others", () => {
    window.history.replaceState(null, "", "/?window=overlay");
    document.documentElement.setAttribute("data-theme", "halftone");
    expect(applyTheme("halftone")).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("the NERV theme and its CRT effects", () => {
  afterEach(() => document.documentElement.removeAttribute("data-crt"));

  it("is a theme that can be saved, read back and put on the page, with a black browser bar", () => {
    saveTheme("nerv");
    expect(readTheme()).toBe("nerv");
    expect(document.documentElement.getAttribute("data-theme")).toBe("nerv");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#000000");
  });

  it("has CRT effects on until switched off, remembers the choice, and survives a browser that will not remember", () => {
    expect(readCrt()).toBe(true);
    saveCrt(false);
    expect(window.localStorage.getItem(CRT_STORAGE_KEY)).toBe("off");
    expect(document.documentElement.getAttribute("data-crt")).toBe("off");
    expect(readCrt()).toBe(false);
    applyCrt(true);
    expect(document.documentElement.hasAttribute("data-crt")).toBe(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readCrt()).toBe(true);
    expect(() => saveCrt(false)).not.toThrow();
    expect(document.documentElement.getAttribute("data-crt")).toBe("off");
  });
});
