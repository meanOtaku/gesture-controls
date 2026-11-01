import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const camera = vi.hoisted(() => ({
  snapshot: { status: "off", recordLandmarks: true } as { status: string; recordLandmarks: boolean },
  enable: vi.fn(async () => undefined),
  setRecordLandmarks: vi.fn(),
}));
vi.mock("../../camera/cameraService", () => ({
  getCameraController: () => ({ subscribe: () => () => undefined, getSnapshot: () => camera.snapshot, enable: camera.enable, setRecordLandmarks: camera.setRecordLandmarks }),
}));
const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => tauri);

import { cameraAssist } from "../../gestureLibrary/cameraAssist";
import { guidedRunner } from "../recording/guidedRunner";
import { telemetryStore } from "../store/telemetryStore";
import { DEFAULT_PINCH_SETTINGS, PinchSessionCard, pinchPlan } from "./PinchSessionCard";

const label = (id: string) => ({ id, displayName: id, description: "", color: "#000000", role: "positiveGesture", builtIn: false, archivedAt: null });

beforeEach(() => {
  localStorage.clear();
  camera.snapshot = { status: "off", recordLandmarks: true };
  camera.enable.mockClear();
  tauri.invoke.mockReset();
  telemetryStore.reset();
  cameraAssist.setEnabled(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("pinchPlan", () => {
  it("cues a pinch, holds, and leaves the labels to the camera", () => {
    expect(pinchPlan(DEFAULT_PINCH_SETTINGS)).toMatchObject({ label: "pinch_in", cues: 20, holdMs: 1000, minGapSeconds: 4, maxGapSeconds: 8, labelCues: false, cueText: "Pinch", activities: [] });
  });
});

describe("PinchSessionCard", () => {
  it("lists what is missing with a fix for each, and starts only when everything is ready", async () => {
    tauri.invoke.mockImplementation(async (command: string) => (command === "list_model_labels" ? [] : undefined));
    const { rerender } = render(<PinchSessionCard recording={false} watchConnected={false} desktopAvailable onStop={() => undefined} />);
    expect(await screen.findByText("Add the labels pinch in, pinch hold and pinch out")).toBeInTheDocument();
    expect(screen.getByText("Connect the watch (Watch page)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start pinch session" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Add them" }));
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("create_model_label", { input: expect.objectContaining({ id: "pinch_out" }) }));
    expect(tauri.invoke).toHaveBeenCalledWith("create_model_label", { input: expect.objectContaining({ id: "pinch_in", role: "positiveGesture" }) });
    expect(tauri.invoke).toHaveBeenCalledWith("create_model_label", { input: expect.objectContaining({ id: "pinch_hold" }) });
    fireEvent.click(screen.getAllByRole("button", { name: "Turn on" })[0]);
    expect(camera.enable).toHaveBeenCalled();

    tauri.invoke.mockImplementation(async (command: string) => (command === "list_model_labels" ? [label("pinch_in"), label("pinch_hold"), label("pinch_out")] : undefined));
    camera.snapshot = { status: "on", recordLandmarks: true };
    cameraAssist.setEnabled(true);
    rerender(<PinchSessionCard recording={false} watchConnected desktopAvailable={false} onStop={() => undefined} />);
    rerender(<PinchSessionCard recording={false} watchConnected desktopAvailable onStop={() => undefined} />);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Start pinch session" })).toBeEnabled());

    const start = vi.spyOn(guidedRunner, "start").mockReturnValue(true);
    const arm = vi.spyOn(cameraAssist, "arm").mockImplementation(() => undefined);
    telemetryStore.selectDatasetLabel("fist");
    telemetryStore.toggleExtraLabel("pinch");
    fireEvent.click(screen.getByRole("button", { name: "Start pinch session" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ label: "pinch_in", labelCues: false }), Math.random, "pinch");
    expect(arm).toHaveBeenCalledWith(["pinch_in", "pinch_hold", "pinch_out"], []);
    expect(telemetryStore.getSelectedLabel()).toBe("pinch_in");
    expect(telemetryStore.getExtraLabels()).toEqual(["pinch_hold", "pinch_out"]);
  });
});
