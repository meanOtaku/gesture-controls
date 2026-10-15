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
  it("starts on neo-brutalism, and switches to the original theme at once, remembering it", () => {
    render(<AppearanceSection />);
    const group = within(screen.getByRole("radiogroup"));
    expect(group.getByRole("radio", { name: /Neo-brutalism/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(group.getByRole("radio", { name: /Electric/ }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("electric");
    expect(screen.getByText(/Deep blue, flat and square/)).toBeInTheDocument();
    fireEvent.click(group.getByRole("radio", { name: /Neo-brutalism/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("neo");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("neo");
  });

  it("shows the saved theme when it opens", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "electric");
    render(<AppearanceSection />);
    expect(within(screen.getByRole("radiogroup")).getByRole("radio", { name: /Electric/ })).toHaveAttribute("aria-checked", "true");
  });

  it("offers Halftone, applies it at once and describes it", () => {
    render(<AppearanceSection />);
    const group = within(screen.getByRole("radiogroup"));
    fireEvent.click(group.getByRole("radio", { name: /Halftone/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("halftone");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("halftone");
    expect(screen.getByText(/Neon Genesis Evangelion/)).toBeInTheDocument();
  });

  it("offers NERV, and only then a switch for the CRT effects, which is remembered", () => {
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
