import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => tauri);

import { cameraAssist } from "../../gestureLibrary/cameraAssist";
import { timedCapture } from "../recording/timedCapture";
import { telemetryStore } from "../store/telemetryStore";
import { GestureRecordingCard } from "./GestureRecordingCard";

const label = (id: string, role = "positiveGesture", extra: Record<string, unknown> = {}) => ({ id, displayName: id.replaceAll("_", " "), description: "", color: "#000000", role, archivedAt: null, ...extra });

beforeEach(() => {
  localStorage.clear();
  telemetryStore.reset();
  timedCapture.reset();
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string) => (command === "list_model_labels"
    ? [label("fist"), label("thumbs_up"), label("everyday_noise", "negativeBackground", { standard: true }), label("old", "positiveGesture", { archivedAt: "2026-10-01" })]
    : []));
  cameraAssist.setEnabled(false);
});
afterEach(() => {
  cleanup();
  telemetryStore.reset();
});

async function sample() {
  telemetryStore.ingestWatchOrientation({ deviceId: "w", sequence: 1, timestampNs: 1, quaternion: [1, 0, 0, 0], accelerometer: [0, 0, 0], gyroscope: [0, 0, 0] });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
}

describe("GestureRecordingCard", () => {
  it("offers only your live gestures, and starts only with one chosen", async () => {
    render(<GestureRecordingCard desktopAvailable onStop={() => undefined} />);
    const select = screen.getByLabelText("Gesture");
    await vi.waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(3));
    expect([...select.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Choose…", "fist", "thumbs up"]);
    expect(screen.getByRole("button", { name: "Start recording" })).toBeDisabled();
    fireEvent.change(select, { target: { value: "fist" } });
    expect(telemetryStore.getSelectedLabel()).toBe("fist");
    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
  });

  it("marks the gesture while the marker is held, when the camera does not mark it", async () => {
    const stop = vi.fn();
    render(<GestureRecordingCard desktopAvailable onStop={stop} />);
    await vi.waitFor(() => expect(screen.getByLabelText("Gesture").querySelectorAll("option")).toHaveLength(3));
    fireEvent.change(screen.getByLabelText("Gesture"), { target: { value: "fist" } });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await sample();
    expect(telemetryStore.getDatasetRecordingState()).toBe("recording");
    const marker = screen.getByRole("button", { name: 'Hold to mark "fist"' });
    fireEvent.pointerDown(marker, { button: 0 });
    expect(telemetryStore.getActiveTimelineLabel()).toBe("fist");
    fireEvent.pointerUp(marker);
    expect(telemetryStore.getActiveTimelineLabel()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop and save" }));
    expect(stop).toHaveBeenCalled();
  });
});
