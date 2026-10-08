import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY } from "../../../shared/theme/theme";
import { AppearanceSection } from "./AppearanceSection";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

describe("AppearanceSection", () => {
  it("starts on the original theme and switches to neo-brutalism at once, remembering it", () => {
    render(<AppearanceSection />);
    const group = within(screen.getByRole("radiogroup"));
    expect(group.getByRole("radio", { name: /Electric/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(group.getByRole("radio", { name: /Neo-brutalism/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("neo");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("neo");
    expect(screen.getByText(/Cream paper, thick black outlines/)).toBeInTheDocument();
    fireEvent.click(group.getByRole("radio", { name: /Electric/ }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("electric");
  });

  it("shows the saved theme when it opens", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neo");
    render(<AppearanceSection />);
    expect(within(screen.getByRole("radiogroup")).getByRole("radio", { name: /Neo-brutalism/ })).toHaveAttribute("aria-checked", "true");
  });
});
