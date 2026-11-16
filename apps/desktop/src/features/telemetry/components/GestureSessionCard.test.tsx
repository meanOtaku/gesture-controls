import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
import { cueOrder, planSteps } from "../recording/guidedSession";
import { telemetryStore } from "../store/telemetryStore";
import { DEFAULT_SESSION_SETTINGS, GestureSessionCard, PINCH, sessionPlan } from "./GestureSessionCard";

const label = (id: string, displayName = id) => ({ id, displayName, description: "", color: "#000000", role: "positiveGesture", builtIn: false, archivedAt: null });
const FIST_RULE = { id: "g-fist", name: "Fist", labelId: "fist", conditions: [] };

function answer(labels: unknown[], definitions: unknown[] = []) {
  tauri.invoke.mockImplementation(async (command: string) => (command === "list_model_labels" ? labels : command === "list_gesture_definitions" ? definitions : undefined));
}
const pick = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Gestures to record" }));
  fireEvent.click(within(screen.getByRole("listbox", { name: "Gestures to record" })).getByRole("option", { name }));
  fireEvent.keyDown(document, { key: "Escape" });
};

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

describe("sessionPlan", () => {
  it("cues pinch as Pinch and leaves it to the camera, and labels a gesture with no camera rule at its cue", () => {
    const plan = sessionPlan({ ...DEFAULT_SESSION_SETTINGS, gestures: [PINCH, "fist", "wave"], each: 3 }, { [PINCH]: "pinch", fist: "camera", wave: "cue" }, (id) => id.toUpperCase());
    expect(plan).toMatchObject({ label: "pinch_in", labels: ["pinch_in", "fist", "wave"], cues: 3, cueLabelled: ["wave"], cueTexts: { pinch_in: "Pinch", fist: "FIST now", wave: "WAVE now" } });
    const order = cueOrder(plan, () => 0.3);
    expect(order.filter((l) => l === "fist")).toHaveLength(3);
    expect(order).toHaveLength(9);
    expect(planSteps(plan, () => 0.3).filter((s) => s.kind === "cue").map((s) => s.label)).toEqual(order);
  });
});

describe("GestureSessionCard", () => {
  it("records pinch as before: it needs the labels and the camera, and the camera marks it", async () => {
    answer([]);
    const { rerender } = render(<GestureSessionCard recording={false} watchConnected={false} desktopAvailable onStop={() => undefined} />);
    expect(await screen.findByText("Add the labels pinch in, pinch hold and pinch out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start gesture session" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add them" }));
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("create_model_label", { input: expect.objectContaining({ id: "pinch_out" }) }));

    answer([label("pinch_in"), label("pinch_hold"), label("pinch_out")]);
    camera.snapshot = { status: "on", recordLandmarks: true };
    cameraAssist.setEnabled(true);
    rerender(<GestureSessionCard recording={false} watchConnected desktopAvailable={false} onStop={() => undefined} />);
    rerender(<GestureSessionCard recording={false} watchConnected desktopAvailable onStop={() => undefined} />);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Start gesture session" })).toBeEnabled());
    const start = vi.spyOn(guidedRunner, "start").mockReturnValue(true);
    const arm = vi.spyOn(cameraAssist, "arm").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Start gesture session" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ labels: ["pinch_in"], cueLabelled: [] }), Math.random, "gesture");
    expect(arm).toHaveBeenCalledWith(["pinch_in", "pinch_hold", "pinch_out"], []);
    expect(telemetryStore.getSelectedLabel()).toBe("pinch_in");
    expect(telemetryStore.getExtraLabels()).toEqual(["pinch_hold", "pinch_out"]);
  });

  it("records other gestures without the camera, labelled at the cue, or marked by the camera from their library rule", async () => {
    answer([label("fist", "Fist"), label("wave", "Wave"), label("pinch_in")], [FIST_RULE]);
    localStorage.setItem("recorder.gestureSession", JSON.stringify({ ...DEFAULT_SESSION_SETTINGS, gestures: [] }));
    render(<GestureSessionCard recording={false} watchConnected desktopAvailable onStop={() => undefined} />);
    await screen.findByRole("button", { name: "Gestures to record" });
    fireEvent.click(screen.getByRole("button", { name: "Gestures to record" }));
    // Pinch is one choice, not its three labels.
    const list = screen.getByRole("listbox", { name: "Gestures to record" });
    expect(within(list).queryByRole("option", { name: "pinch_in" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await vi.waitFor(() => expect(within(screen.getByRole("button", { name: "Gestures to record" }).parentElement!).queryByText("Fist")).toBeNull());
    pick("Fist");
    pick("Wave");
    expect(screen.getByText(/Fist, Wave: labelled at the cue/)).toBeInTheDocument();
    const start = vi.spyOn(guidedRunner, "start").mockReturnValue(true);
    const arm = vi.spyOn(cameraAssist, "arm").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Start gesture session" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ labels: ["fist", "wave"], cueLabelled: ["fist", "wave"] }), Math.random, "gesture");
    expect(arm).not.toHaveBeenCalled();
    expect(telemetryStore.getSelectedLabel()).toBe("fist");
    expect(telemetryStore.getExtraLabels()).toEqual(["wave"]);

    // With the camera on and marking, the fist is the camera's to mark.
    cleanup();
    camera.snapshot = { status: "on", recordLandmarks: true };
    cameraAssist.setEnabled(true);
    render(<GestureSessionCard recording={false} watchConnected desktopAvailable onStop={() => undefined} />);
    expect(await screen.findByText(/Fist: marked by the camera, from its Gesture library rule/)).toBeInTheDocument();
    start.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Start gesture session" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ cueLabelled: ["wave"] }), Math.random, "gesture");
    expect(arm).toHaveBeenCalledWith(["fist"], [FIST_RULE]);
  });
});
