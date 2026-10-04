import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetectionActivity } from "./DetectionActivity";

let handler: ((event: { payload: unknown }) => void) | undefined;
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, fn: (event: { payload: unknown }) => void) => {
    handler = fn;
    return Promise.resolve(unlisten);
  },
}));

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
});
