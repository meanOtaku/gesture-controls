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
    if (command === "get_overlay_state") {
      return Promise.resolve({ visible: false, grabbed: false, volume: 50, rotationAngle: 0, screenX: 0, screenY: 0 });
    }
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("App overlay integration", () => {
  it("ignores volume keys while the overlay is hidden", async () => {
    render(<App />);
    await waitFor(() => expect(listeners.has(HEAD_TARGET_ENTERED_EVENT)).toBe(true));
    invoke.mockClear();

    fireEvent.keyDown(window, { key: "ArrowUp" });

    expect(invoke).not.toHaveBeenCalledWith("adjust_system_volume", expect.anything());
  });

  it("reconciles an already-visible overlay before handling volume keys", async () => {
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
      if (command === "get_overlay_state") return Promise.resolve({ visible: true, volume: 50 });
      return Promise.resolve(undefined);
    });

    render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_overlay_state"));
    fireEvent.keyDown(window, { key: "ArrowUp" });

    expect(invoke).toHaveBeenCalledWith("adjust_system_volume", { delta: 5 });
  });

  it("does not let an older main-window overlay snapshot hide a newer visible event", async () => {
    let resolveOverlaySnapshot: (state: unknown) => void = () => undefined;
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
      if (command === "get_overlay_state") {
        return new Promise((resolve) => { resolveOverlaySnapshot = resolve; });
      }
      return Promise.resolve(undefined);
    });

    render(<App />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_overlay_state"));
    await act(async () => listeners.get(OVERLAY_STATE_EVENT)?.({ payload: { visible: true } }));
    await act(async () => resolveOverlaySnapshot({ visible: false, volume: 50 }));
    fireEvent.keyDown(window, { key: "ArrowUp" });

    expect(invoke).toHaveBeenCalledWith("adjust_system_volume", { delta: 5 });
  });

  it("shows the knob for the top-right target and supports keyboard system volume control", async () => {
    render(<App />);
    await waitFor(() => expect(listeners.has(HEAD_TARGET_ENTERED_EVENT)).toBe(true));

    await act(async () => listeners.get(HEAD_TARGET_ENTERED_EVENT)?.({ payload: "topRight" }));
    expect(invoke).toHaveBeenCalledWith("show_overlay");
    await act(async () => listeners.get(OVERLAY_STATE_EVENT)?.({ payload: { visible: true } }));

    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(invoke).toHaveBeenCalledWith("adjust_system_volume", { delta: 5 });

    await act(async () => listeners.get(HEAD_TRACKER_CONNECTION_EVENT)?.({ payload: false }));
    expect(invoke).toHaveBeenCalledWith("hide_overlay");
  });

  it("limits key repeat to one native volume adjustment at a time", async () => {
    let resolveAdjustment: (() => void) | undefined;
    const adjustment = new Promise<void>((resolve) => { resolveAdjustment = resolve; });
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
      if (command === "get_overlay_state") return Promise.resolve({ visible: false, volume: 50 });
      if (command === "adjust_system_volume") return adjustment;
      return Promise.resolve(undefined);
    });

    render(<App />);
    await waitFor(() => expect(listeners.has(OVERLAY_STATE_EVENT)).toBe(true));
    await act(async () => listeners.get(OVERLAY_STATE_EVENT)?.({ payload: { visible: true } }));
    invoke.mockClear();

    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "ArrowUp" });

    expect(invoke.mock.calls.filter(([command]) => command === "adjust_system_volume")).toHaveLength(1);

    await act(async () => resolveAdjustment?.());
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(invoke.mock.calls.filter(([command]) => command === "adjust_system_volume")).toHaveLength(2);
  });

  it("surfaces hide failures and keeps keyboard fail-closed after stale visible events", async () => {
    let rejectHide: ((error: Error) => void) | undefined;
    const hideRequest = new Promise<void>((_resolve, reject) => { rejectHide = reject; });
    invoke.mockImplementation((command: string) => {
      if (command === "get_calibration_state") return Promise.resolve({
        centerCalibrated: true,
        topRightCalibrated: true,
        requiresRecalibration: false,
        activationThresholdDegrees: 12,
        dwellMs: 400,
        activeTarget: null,
      });
      if (command === "get_overlay_state") return Promise.resolve({ visible: false, volume: 50 });
      if (command === "hide_overlay") return hideRequest;
      return Promise.resolve(undefined);
    });

    render(<App />);
    await waitFor(() => expect(listeners.has(OVERLAY_STATE_EVENT)).toBe(true));
    await act(async () => listeners.get(OVERLAY_STATE_EVENT)?.({ payload: { visible: true } }));
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => listeners.get(OVERLAY_STATE_EVENT)?.({ payload: { visible: true } }));
    await act(async () => rejectHide?.(new Error("window refused to hide")));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /volume overlay failed to hide.*window refused to hide/i,
    );
    invoke.mockClear();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(invoke).not.toHaveBeenCalledWith("adjust_system_volume", expect.anything());
  });

  it("keeps a newer volume failure when an older request succeeds later", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstShow = new Promise<void>((resolve) => { resolveFirst = resolve; });
    let showCalls = 0;
    invoke.mockImplementation((command: string) => {
      if (command === "get_calibration_state") return Promise.resolve({
        centerCalibrated: true,
        topRightCalibrated: true,
        requiresRecalibration: false,
        activationThresholdDegrees: 12,
        dwellMs: 400,
        activeTarget: null,
      });
      if (command === "get_overlay_state") return Promise.resolve({ visible: false, volume: 50 });
      if (command === "show_overlay") {
        showCalls += 1;
        return showCalls === 1 ? firstShow : Promise.reject(new Error("newer volume failure"));
      }
      return Promise.resolve(undefined);
    });

    render(<App />);
    await waitFor(() => expect(listeners.has(HEAD_TARGET_ENTERED_EVENT)).toBe(true));
    await act(async () => listeners.get(HEAD_TARGET_ENTERED_EVENT)?.({ payload: "topRight" }));
    await act(async () => listeners.get(HEAD_TARGET_ENTERED_EVENT)?.({ payload: "topRight" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/newer volume failure/i);

    await act(async () => resolveFirst?.());
    expect(screen.getByRole("alert")).toHaveTextContent(/newer volume failure/i);
  });

  it("ignores an older volume failure after a newer request succeeds", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const firstShow = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    let showCalls = 0;
    invoke.mockImplementation((command: string) => {
      if (command === "get_calibration_state") return Promise.resolve({
        centerCalibrated: true,
        topRightCalibrated: true,
        requiresRecalibration: false,
        activationThresholdDegrees: 12,
        dwellMs: 400,
        activeTarget: null,
      });
      if (command === "get_overlay_state") return Promise.resolve({ visible: false, volume: 50 });
      if (command === "show_overlay") {
        showCalls += 1;
        return showCalls === 1 ? firstShow : Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    render(<App />);
    await waitFor(() => expect(listeners.has(HEAD_TARGET_ENTERED_EVENT)).toBe(true));
    await act(async () => listeners.get(HEAD_TARGET_ENTERED_EVENT)?.({ payload: "topRight" }));
    await act(async () => listeners.get(HEAD_TARGET_ENTERED_EVENT)?.({ payload: "topRight" }));

    await act(async () => rejectFirst?.(new Error("stale volume failure")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows calibration and volume failures together", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_calibration_state") return Promise.resolve({
        centerCalibrated: true,
        topRightCalibrated: true,
        requiresRecalibration: false,
        activationThresholdDegrees: 12,
        dwellMs: 400,
        activeTarget: null,
      });
      if (command === "get_overlay_state") return Promise.resolve({ visible: false, volume: 50 });
      if (command === "adjust_system_volume") return Promise.reject(new Error("volume unavailable"));
      if (command === "capture_calibration_target") return Promise.reject(new Error("calibration unavailable"));
      return Promise.resolve(undefined);
    });

    render(<App />);
    await waitFor(() => expect(listeners.has(OVERLAY_STATE_EVENT)).toBe(true));
    await act(async () => listeners.get(HEAD_TRACKER_CONNECTION_EVENT)?.({ payload: true }));
    await act(async () => listeners.get(OVERLAY_STATE_EVENT)?.({ payload: { visible: true } }));
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/volume unavailable/i);

    fireEvent.click(screen.getByRole("button", { name: /capture center/i }));
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(/volume unavailable/i);
      expect(alert).toHaveTextContent(/calibration unavailable/i);
    });
  });

  it("surfaces failure to read system volume when opening the overlay", async () => {
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
      if (command === "get_overlay_state") return Promise.resolve({ visible: false, volume: 50 });
      if (command === "show_overlay") return Promise.reject(new Error("cannot read output volume"));
      return Promise.resolve(undefined);
    });

    render(<App />);
    await waitFor(() => expect(listeners.has(HEAD_TARGET_ENTERED_EVENT)).toBe(true));
    await act(async () => listeners.get(HEAD_TARGET_ENTERED_EVENT)?.({ payload: "topRight" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /volume control failed.*cannot read output volume/i,
    );
  });

  it("surfaces native volume backend failures", async () => {
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
      if (command === "get_overlay_state") return Promise.resolve({ visible: false, volume: 50 });
      if (command === "adjust_system_volume") return Promise.reject(new Error("audio device unavailable"));
      return Promise.resolve(undefined);
    });

    render(<App />);
    await waitFor(() => expect(listeners.has(OVERLAY_STATE_EVENT)).toBe(true));
    await act(async () => listeners.get(OVERLAY_STATE_EVENT)?.({ payload: { visible: true } }));
    fireEvent.keyDown(window, { key: "ArrowUp" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /volume control failed.*audio device unavailable/i,
    );
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

  it("refreshes native system volume while the overlay is visible", async () => {
    window.history.replaceState({}, "", "/?window=overlay");
    invoke.mockImplementation((command: string) => {
      if (command === "get_overlay_state") return Promise.resolve({ visible: true, volume: 42 });
      if (command === "refresh_system_volume") return Promise.resolve({ visible: true, volume: 73 });
      return Promise.resolve(undefined);
    });

    render(<App />);

    expect(await screen.findByRole("meter", { name: "Current volume" })).toHaveAttribute("aria-valuenow", "42");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("refresh_system_volume"));
    await act(async () => listeners.get(OVERLAY_STATE_EVENT)?.({ payload: { visible: true, volume: 73 } }));
    expect(screen.getByRole("meter", { name: "Current volume" })).toHaveAttribute("aria-valuenow", "73");
  });

  it("keeps one native refresh in flight across rapid hide and show events", async () => {
    window.history.replaceState({}, "", "/?window=overlay");
    const refreshRequest = new Promise(() => undefined);
    invoke.mockImplementation((command: string) => {
      if (command === "get_overlay_state") return Promise.resolve({ visible: true, volume: 42 });
      if (command === "refresh_system_volume") return refreshRequest;
      return Promise.resolve(undefined);
    });

    render(<App />);

    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "refresh_system_volume")).toHaveLength(1));
    await act(async () => listeners.get(OVERLAY_STATE_EVENT)?.({ payload: { visible: false, volume: 42 } }));
    await act(async () => listeners.get(OVERLAY_STATE_EVENT)?.({ payload: { visible: true, volume: 42 } }));

    expect(invoke.mock.calls.filter(([command]) => command === "refresh_system_volume")).toHaveLength(1);
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
