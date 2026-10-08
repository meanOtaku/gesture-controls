import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, applyTheme, readTheme, saveTheme } from "./theme";

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
  it("is the original look until another is chosen, and ignores anything it does not know", () => {
    expect(readTheme()).toBe("electric");
    window.localStorage.setItem(THEME_STORAGE_KEY, "rainbow");
    expect(readTheme()).toBe("electric");
    window.localStorage.setItem(THEME_STORAGE_KEY, "neo");
    expect(readTheme()).toBe("neo");
  });

  it("marks the page for the chosen theme and clears the mark for the original", () => {
    expect(applyTheme("neo")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("neo");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#fbf3e4");
    applyTheme("electric");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#000066");
  });

  it("remembers the choice", () => {
    saveTheme("neo");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("neo");
    expect(document.documentElement.getAttribute("data-theme")).toBe("neo");
  });

  it("never themes the floating volume knob's window", () => {
    window.history.replaceState(null, "", "/?window=overlay");
    expect(applyTheme("neo")).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("still works when the browser will not remember", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readTheme()).toBe("electric");
    expect(() => saveTheme("neo")).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("neo");
  });
});
