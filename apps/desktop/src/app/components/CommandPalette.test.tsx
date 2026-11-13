import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

beforeAll(() => {
  // cmdk measures its list and scrolls the chosen item into view; jsdom has neither.
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

describe("CommandPalette", () => {
  it("opens with Ctrl+K, finds a page by typing and goes to it", () => {
    const onSelect = vi.fn();
    render(<CommandPalette onSelect={onSelect} />);
    expect(screen.queryByPlaceholderText(/Go to a page/)).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByPlaceholderText(/Go to a page/);
    expect(screen.getByText("Overview")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "recip" } });
    expect(screen.getByText("Recipes")).toBeInTheDocument();
    expect(screen.queryByText("Overview")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("recipes");
    expect(screen.queryByPlaceholderText(/Go to a page/)).not.toBeInTheDocument();
  });

  it("offers the camera and the shortcuts everywhere, and marking a miss only in the desktop app", () => {
    render(<CommandPalette onSelect={vi.fn()} />);
    fireEvent.keyDown(window, { key: "K", metaKey: true });
    expect(screen.getByText("Turn the camera on")).toBeInTheDocument();
    expect(screen.getByText("Show keyboard shortcuts")).toBeInTheDocument();
    expect(screen.queryByText(/Mark a miss/)).not.toBeInTheDocument();
    // The same keys close it again.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByText("Turn the camera on")).not.toBeInTheDocument();
  });
});
