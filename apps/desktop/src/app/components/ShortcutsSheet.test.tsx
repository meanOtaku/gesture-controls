import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ShortcutsSheet, shortcutGroups } from "./ShortcutsSheet";

afterEach(cleanup);

describe("the keyboard shortcuts", () => {
  it("open with ?, but not while typing", async () => {
    render(<><input aria-label="field" /><ShortcutsSheet /></>);
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "?" });
    expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
    fireEvent.keyDown(window, { key: "?" });
    expect(await screen.findByText("Keyboard shortcuts")).toBeInTheDocument();
    expect(screen.getByText("Previous / next place to check")).toBeInTheDocument();
  });

  it("name the platform's command key", () => {
    expect(shortcutGroups(true)[0].keys[0][0]).toBe("⌘1 … ⌘9");
    expect(shortcutGroups(false)[0].keys[0][0]).toBe("Ctrl+1 … Ctrl+9");
  });
});
