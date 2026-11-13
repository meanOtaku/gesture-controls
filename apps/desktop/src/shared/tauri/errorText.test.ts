import { afterEach, describe, expect, it } from "vitest";
import { errorText } from "./errorText";

describe("errorText", () => {
  afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

  it("says the desktop app is needed in the browser preview, and shows the backend's own words in the app", () => {
    const failure = new TypeError("Cannot read properties of undefined (reading 'invoke')");
    expect(errorText(failure)).toBe("This needs the desktop app, so it is unavailable in browser preview.");
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(errorText("the watch is not connected")).toBe("the watch is not connected");
  });
});
