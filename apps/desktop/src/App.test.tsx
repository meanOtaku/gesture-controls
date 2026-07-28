import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import {
  HEAD_TARGET_ENTERED_EVENT,
  HEAD_TRACKER_CONNECTION_EVENT,
  OVERLAY_STATE_EVENT,
} from "./protocol/events";

const { invoke, listeners, listen } = vi.hoisted(() => {
  const eventListeners = new Map<string, (event: { payload: unknown }) => void>();
  return {
    invoke: vi.fn(),
    listeners: eventListeners,
    listen: vi.fn((event: string, callback: (event: { payload: unknown }) => void) => {
      eventListeners.set(event, callback);
      return Promise.resolve(() => eventListeners.delete(event));
    }),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  window.history.replaceState({}, "", "/");
  listeners.clear();
  invoke.mockReset();
  listen.mockClear();
  invoke.mockImplementation((command: string) => {
    if (command === "get_calibration_state") {
      return Promise.resolve({
        centerCalibrated: true,
        topRightCalibrated: true,
        requiresRecalibration: false,
        activationThresholdDegrees: 12,
        dwellMs: 400,
        activeTarget: null,
      });
    }
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("App overlay integration", () => {
  it("shows the knob for the top-right target and supports keyboard volume simulation", async () => {
    render(<App />);
    await waitFor(() => expect(listeners.has(HEAD_TARGET_ENTERED_EVENT)).toBe(true));

    await act(async () => listeners.get(HEAD_TARGET_ENTERED_EVENT)?.({ payload: "topRight" }));
    expect(invoke).toHaveBeenCalledWith("show_overlay");

    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(invoke).toHaveBeenCalledWith("adjust_simulated_volume", { delta: 5 });

    await act(async () => listeners.get(HEAD_TRACKER_CONNECTION_EVENT)?.({ payload: false }));
    expect(invoke).toHaveBeenCalledWith("hide_overlay");
  });

  it("reconciles an already-active top-right target after listeners register", async () => {
    invoke.mockImplementation((command: string) => command === "get_calibration_state"
      ? Promise.resolve({
        centerCalibrated: true,
        topRightCalibrated: true,
        requiresRecalibration: false,
        activationThresholdDegrees: 12,
        dwellMs: 400,
        activeTarget: "topRight",
      })
      : Promise.resolve(undefined));

    render(<App />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("show_overlay"));
  });

  it("does not let an older overlay snapshot overwrite a newer event", async () => {
    window.history.replaceState({}, "", "/?window=overlay");
    let resolveSnapshot: (state: unknown) => void = () => undefined;
    invoke.mockImplementation((command: string) => command === "get_overlay_state"
      ? new Promise((resolve) => { resolveSnapshot = resolve; })
      : Promise.resolve(undefined));

    render(<App />);
    await waitFor(() => expect(listeners.has(OVERLAY_STATE_EVENT)).toBe(true));
    await act(async () => listeners.get(OVERLAY_STATE_EVENT)?.({ payload: { visible: true, volume: 77 } }));
    await act(async () => resolveSnapshot({ visible: true, volume: 42 }));

    expect(screen.getByRole("meter", { name: "Current volume" })).toHaveAttribute("aria-valuenow", "77");
  });

  it("renders and updates the dedicated overlay window", async () => {
    window.history.replaceState({}, "", "/?window=overlay");
    invoke.mockImplementation((command: string) => command === "get_overlay_state"
      ? Promise.resolve({ visible: true, volume: 42 })
      : Promise.resolve(undefined));

    render(<App />);

    const meter = await screen.findByRole("meter", { name: "Current volume" });
    await waitFor(() => expect(meter).toHaveAttribute("aria-valuenow", "42"));
    await act(async () => listeners.get(OVERLAY_STATE_EVENT)?.({ payload: { visible: true, volume: 77 } }));
    expect(screen.getByRole("meter", { name: "Current volume" })).toHaveAttribute("aria-valuenow", "77");
  });
});
