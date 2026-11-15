import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CRT_STORAGE_KEY, THEME_STORAGE_KEY } from "../../../shared/theme/theme";
import { AppearanceSection } from "./AppearanceSection";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-crt");
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

describe("AppearanceSection", () => {
  it("starts on NERV, offers only it and neo-brutalism, and switches at once, remembering it", () => {
    render(<AppearanceSection />);
    const group = within(screen.getByRole("radiogroup"));
    expect(group.getByRole("radio", { name: /NERV/ })).toHaveAttribute("aria-checked", "true");
    expect(group.getAllByRole("radio")).toHaveLength(2);
    expect(group.queryByRole("radio", { name: /Electric/ })).toBeNull();
    fireEvent.click(group.getByRole("radio", { name: /Neo-brutalism/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("neo");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("neo");
    fireEvent.click(group.getByRole("radio", { name: /NERV/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("nerv");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("nerv");
  });

  it("shows the saved theme when it opens", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "nerv");
    render(<AppearanceSection />);
    expect(within(screen.getByRole("radiogroup")).getByRole("radio", { name: /NERV/ })).toHaveAttribute("aria-checked", "true");
  });

  it("no longer offers Halftone", () => {
    render(<AppearanceSection />);
    expect(within(screen.getByRole("radiogroup")).queryByRole("radio", { name: /Halftone/ })).toBeNull();
  });

  it("offers a switch for the CRT effects only under NERV, which is remembered", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neo");
    render(<AppearanceSection />);
    expect(screen.queryByRole("switch", { name: "CRT effects" })).toBeNull();
    fireEvent.click(within(screen.getByRole("radiogroup")).getByRole("radio", { name: /NERV/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("nerv");
    const crt = screen.getByRole("switch", { name: "CRT effects" });
    expect(crt).toHaveAttribute("aria-checked", "true");
    fireEvent.click(crt);
    expect(document.documentElement.getAttribute("data-crt")).toBe("off");
    expect(window.localStorage.getItem(CRT_STORAGE_KEY)).toBe("off");
    fireEvent.click(crt);
    expect(document.documentElement.hasAttribute("data-crt")).toBe(false);
  });
});
