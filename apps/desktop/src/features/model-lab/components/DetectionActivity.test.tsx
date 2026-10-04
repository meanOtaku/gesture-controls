import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetectionActivity } from "./DetectionActivity";

let handler: ((event: { payload: unknown }) => void) | undefined;
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, fn: (event: { payload: unknown }) => void) => {
    handler = fn;
    return Promise.resolve(unlisten);
  },
}));

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { cleanup(); handler = undefined; unlisten.mockClear(); });

describe("DetectionActivity", () => {
  it("starts empty and shows detections and releases as they arrive, newest first", async () => {
    render(<DetectionActivity desktopAvailable />);
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
    await vi.waitFor(() => expect(handler).toBeDefined());
    act(() => handler?.({ payload: { events: [{ kind: "rising", label: "snap", confidence: 0.9, timestampNs: 1 }], conflicts: [], rejections: [] } }));
    act(() => handler?.({ payload: { events: [{ kind: "falling", label: "snap", timestampNs: 2, reason: "scoreBelowRelease" }], conflicts: [], rejections: [] } }));
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("snap released: ended normally");
    expect(items[1]).toContain("snap detected (90%)");
  });

  it("ignores a report with only ongoing detections, and listens only in the desktop app", async () => {
    render(<DetectionActivity desktopAvailable />);
    await vi.waitFor(() => expect(handler).toBeDefined());
    act(() => handler?.({ payload: { events: [{ kind: "active", label: "snap", confidence: 0.9, timestampNs: 1 }], conflicts: [], rejections: [] } }));
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
    cleanup();
    handler = undefined;
    render(<DetectionActivity desktopAvailable={false} />);
    expect(handler).toBeUndefined();
  });

  it("stops listening when it goes away", async () => {
    const { unmount } = render(<DetectionActivity desktopAvailable />);
    await vi.waitFor(() => expect(handler).toBeDefined());
    await vi.waitFor(() => expect(unlisten).not.toHaveBeenCalled());
    unmount();
    expect(unlisten).toHaveBeenCalled();
  });

  it("collapses out of the way, counts what is inside, and is remembered", async () => {
    const { unmount } = render(<DetectionActivity desktopAvailable />);
    await vi.waitFor(() => expect(handler).toBeDefined());
    act(() => handler?.({ payload: { events: [{ kind: "rising", label: "snap", confidence: 0.9, timestampNs: 1 }], conflicts: [], rejections: [] } }));
    const toggle = screen.getByRole("button", { name: "Collapse" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Recent detections")).toBeVisible();

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Expand (1)" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Recent detections")).not.toBeVisible();
    // New activity still arrives while it is closed, and shows in the count.
    act(() => handler?.({ payload: { events: [{ kind: "falling", label: "snap", timestampNs: 2, reason: "scoreBelowRelease" }], conflicts: [], rejections: [] } }));
    expect(screen.getByRole("button", { name: "Expand (2)" })).toBeInTheDocument();

    // Coming back to the page finds it as it was left.
    unmount();
    render(<DetectionActivity desktopAvailable />);
    expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument();
  });

  it("still works when the browser will not remember", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    render(<DetectionActivity desktopAvailable />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument();
    get.mockRestore();
    set.mockRestore();
  });
});
