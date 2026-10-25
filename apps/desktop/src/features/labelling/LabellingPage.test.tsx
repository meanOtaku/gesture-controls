import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabellingRecording } from "./labellingApi";

const { invoke, openDialog, saveDialog } = vi.hoisted(() => ({ invoke: vi.fn(), openDialog: vi.fn(), saveDialog: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog, save: saveDialog }));
const feedback = vi.hoisted(() => ({ success: vi.fn(), withUndo: vi.fn() }));
vi.mock("../../components/app/OperationFeedback", () => ({
  OperationFeedback: { success: feedback.success, error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  feedbackWithUndo: feedback.withUndo,
}));

vi.mock("./cameraTrack", async (actual) => ({
  ...(await actual<typeof import("./cameraTrack")>()),
  // The fingers close at 0.3 s and again at 0.7 s on the recording's timeline.
  cameraTrack: () => ({ track: { timesMs: [0, 100, 300, 500, 700, 900], values: [0.9, 0.8, 0.1, 0.9, 0.2, 0.9], hands: [[], [], [], [], [], []], jitterMs: 12, frames: 6 } }),
}));

import { appNavigation } from "../../shared/navigation/appNavigation";
import { forgetLabellingWork, LabellingPage } from "./LabellingPage";

const recording: LabellingRecording = {
  name: "pinch session",
  source: { kind: "dataset", id: "d1" },
  durationMs: 1000,
  originNs: "0",
  ppg: { timesMs: [0, 500, 1000], columns: [{ name: "ppg_green", values: [1, 2, null] }, { name: "ppg_red", values: [1, 1, 1] }, { name: "ppg_ir", values: [3, 2, 1] }, { name: "contact_quality", values: [0, 0, 0] }] },
  imu: { timesMs: [250, 750], columns: ["accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z", "quat_w", "quat_x", "quat_y", "quat_z"].map((name) => ({ name, values: [0.1, 0.2] })) },
  labelIntervals: [{ startMs: 500, endMs: 1000, label: "pinch" }],
  manualIntervals: [],
};

function respond() {
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "list_model_datasets":
        return [{ id: "d1", originalFilename: "pinch session", importedAt: "", label: "pinch", rowCount: 5, sequence: 3, sourceRecordingId: "rec-1" }];
      case "get_recording_camera_evidence":
        return { handLandmarks: "header", handLandmarksSecond: null, clockSync: "header", rawTimestampsNs: [] };
      case "list_model_labels":
        return [
          { id: "pinch", displayName: "Pinch", description: "", color: "#ff0", role: "positiveGesture", archivedAt: null },
          { id: "fist", displayName: "Fist", description: "", color: "#0ff", role: "positiveGesture", archivedAt: null },
          { id: "everything_else", displayName: "Everything else", description: "", color: "#888", role: "negativeBackground", archivedAt: null },
        ];
      case "labelling_model_replay":
        // One detection 0.8 s after the recorded pinch start at 0.5 s (caught), one at 0.2 s (false).
        return [{ label: "pinch", version: "pinch-v1", threshold: 0.9, timesMs: [0, 500, 1000], scores: [0.1, 0.95, 0.2], detections: [{ startMs: 200, endMs: 240, label: "pinch" }, { startMs: 1300, endMs: 1340, label: "pinch" }], rejections: [] }];
      case "open_labelling_recording":
        return { ...recording, source: args?.source };
      case "save_labelling_version":
        return { id: "d2", originalFilename: "pinch session (labelled)", importedAt: "", label: "fist, pinch", rowCount: 5, sequence: 4 };
      case "export_labelling_recording":
        return "/exports/pinch-session-labelled";
      default:
        return null;
    }
  });
}

/** Opens the Model Lab recording and gives the lanes a width, so dragging maps to time. */
async function openRecording() {
  render(<LabellingPage />);
  fireEvent.click(await screen.findByRole("combobox", { name: "Model Lab recording" }));
  fireEvent.click(await screen.findByRole("option", { name: /#3 pinch session/ }));
  await screen.findByRole("list", { name: "Recorded labels" });
  const lanes = document.querySelector(".labelling-lanes") as HTMLElement;
  lanes.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, right: 1000, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  return lanes;
}

function drag(lanes: HTMLElement, fromX: number, toX: number) {
  fireEvent.pointerDown(lanes, { button: 0, clientX: fromX, pointerId: 1 });
  fireEvent.pointerMove(lanes, { clientX: toX, pointerId: 1 });
  fireEvent.pointerUp(lanes, { clientX: toX, pointerId: 1 });
}

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  respond();
});
afterEach(() => {
  cleanup();
  forgetLabellingWork();
  invoke.mockReset();
  vi.restoreAllMocks();
});

describe("LabellingPage", () => {
  it("draws a lane for each column but the rarely useful ones, and the recorded labels on their rail", async () => {
    await openRecording();
    expect(screen.getByRole("img", { name: "PPG green over the view" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Rotation z over the view" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Orientation w over the view" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Recorded labels" })).getByRole("listitem")).toHaveTextContent("Pinch");
    fireEvent.click(screen.getByRole("checkbox", { name: /Orientation w/ }));
    expect(screen.getByRole("img", { name: "Orientation w over the view" })).toBeInTheDocument();
  });

  it("lets up and down scrolling scroll the page, and zooms where the cursor is only with Ctrl or ⌘", async () => {
    const lanes = await openRecording();
    const page = document.scrollingElement ?? document.documentElement;
    const scrollBy = vi.fn();
    page.scrollBy = scrollBy;
    const scroll = new WheelEvent("wheel", { deltaY: -100, clientX: 500, cancelable: true });
    act(() => void lanes.dispatchEvent(scroll));
    expect(scrollBy).toHaveBeenCalledWith({ top: -100 });
    expect(screen.getByText(/Showing 0\.000 s to 1\.000 s/)).toBeInTheDocument();
    const zoomIn = new WheelEvent("wheel", { deltaY: -100, clientX: 500, ctrlKey: true, cancelable: true });
    act(() => void lanes.dispatchEvent(zoomIn));
    expect(zoomIn.defaultPrevented).toBe(true);
    expect(screen.getByText(/Showing 0\.100 s to 0\.900 s/)).toBeInTheDocument();
    const along = new WheelEvent("wheel", { deltaX: 100, cancelable: true });
    act(() => void lanes.dispatchEvent(along));
    expect(along.defaultPrevented).toBe(true);
    // An up-and-down trackpad scroll that drifts a little sideways still scrolls the page.
    const drifting = new WheelEvent("wheel", { deltaX: 6, deltaY: 5, cancelable: true });
    act(() => void lanes.dispatchEvent(drifting));
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 5 });
  });

  it("labels a dragged selection with the chosen label, undoes it, and erases", async () => {
    const lanes = await openRecording();
    drag(lanes, 100, 300);
    expect(screen.getByText(/Selected 0\.100 s to 0\.300 s/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "2" }); // the second label: Fist
    fireEvent.keyDown(window, { key: "Enter" });
    const byHand = () => within(screen.getByRole("list", { name: "By hand labels" })).queryAllByRole("listitem");
    expect(byHand().map((item) => item.textContent)).toEqual(["Fist"]);
    expect(screen.getByText("Unsaved labels")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(byHand()).toHaveLength(0);
    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
    expect(byHand()).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(byHand()).toHaveLength(0);
  });

  it("saves a new version with the hand labels and opens it, leaving the original", async () => {
    const lanes = await openRecording();
    drag(lanes, 0, 400);
    fireEvent.click(screen.getByRole("button", { name: /^Nothing here/ }));
    fireEvent.click(screen.getByRole("button", { name: /Label selection: Nothing here/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save as new version" })));
    const saved = invoke.mock.calls.find(([command]) => command === "save_labelling_version");
    expect(saved?.[1]).toEqual({ source: { kind: "dataset", id: "d1" }, intervals: [{ startMs: 0, endMs: 400, label: "-" }] });
    await waitFor(() => expect(feedback.success).toHaveBeenCalledWith("Saved", expect.stringContaining("#4 pinch session (labelled)")));
    expect(invoke).toHaveBeenCalledWith("open_labelling_recording", { source: { kind: "dataset", id: "d2" } });
  });

  it("runs the active model, tells caught starts from false detections, and selects a false one to mark", async () => {
    await openRecording();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Run the active models" })));
    expect(screen.getByRole("img", { name: "Pinch score over the view" })).toBeInTheDocument();
    expect(screen.getByText(/2 detections, 1 catching one of the 1 labelled starts and 1 elsewhere/)).toBeInTheDocument();
    const rail = screen.getByRole("list", { name: "Model: Pinch labels" });
    expect(within(rail).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["false?"]); // the other is past the 1 s view
    fireEvent.click(within(rail).getByRole("listitem"));
    // From 880 ms before the detection: the moment training will take as a negative, labelled with the everyday label.
    expect(screen.getByText(/Selected 0\.000 s to 0\.320 s/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Label selection: Everything else/ })).toBeInTheDocument();
    // Label timing: the model's detections fit these labels best as they are, and moving them is offered.
    const timing = screen.getByRole("region", { name: "Label timing" });
    expect(timing).toHaveTextContent("catch the most starts (1, against 1 as labelled)");
    fireEvent.click(within(timing).getByRole("button", { name: "Move the labels to the model" }));
    expect(feedback.withUndo).toHaveBeenCalledWith("Labels moved", expect.stringContaining("0 ms earlier"), expect.any(Function));
  });

  it("draws the camera's thumb-to-index distance and starts a selection where the fingers touched", async () => {
    await openRecording();
    expect(await screen.findByRole("img", { name: "Camera: thumb to index over the view" })).toBeInTheDocument();
    expect(screen.getByText(/lined up with the watch to about 12 ms/)).toBeInTheDocument();
    const contacts = within(screen.getByRole("list", { name: "Camera contact labels" })).getAllByRole("listitem");
    expect(contacts).toHaveLength(2);
    fireEvent.click(contacts[1]);
    expect(screen.getByText(/Selected 0\.700 s to 1\.700 s/)).toBeInTheDocument();
  });

  it("exports as a folder by default, and as one CSV when chosen", async () => {
    await openRecording();
    openDialog.mockResolvedValue("/exports");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export…" })));
    expect(invoke).toHaveBeenCalledWith("export_labelling_recording", {
      source: { kind: "dataset", id: "d1" },
      intervals: [],
      target: { kind: "folder", parent: "/exports", name: "pinch-session-labelled" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /One CSV/ }));
    saveDialog.mockResolvedValue("/exports/one.csv");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export…" })));
    expect(invoke).toHaveBeenCalledWith("export_labelling_recording", expect.objectContaining({ target: { kind: "csv", path: "/exports/one.csv" } }));
  });

  it("opens the recording another page asks for, at the moment it asks, with its stretch selected", async () => {
    appNavigation.openInLabelling({ datasetId: "d1", atMs: 600, select: { startMs: 400, endMs: 700 } });
    render(<LabellingPage />);
    await screen.findByRole("list", { name: "Recorded labels" });
    expect(invoke).toHaveBeenCalledWith("open_labelling_recording", { source: { kind: "dataset", id: "d1" } });
    expect(screen.getByText(/Selected 0\.400 s to 0\.700 s/)).toBeInTheDocument();
    expect(appNavigation.takeLabellingFocus()).toBeNull();
  });

  it("reviews the unlabelled stretches it suggests, one at a time, labelling each with Enter", async () => {
    await openRecording();
    const bar = await screen.findByRole("region", { name: "Suggestions" });
    // The fingers closed 0.3 to 0.5 s, with nothing labelled (the second closing is inside the recorded pinch).
    await waitFor(() => expect(within(bar).getByText("1 suggestion")).toBeInTheDocument());
    fireEvent.click(within(bar).getByRole("button", { name: "Review them" }));
    expect(within(bar).getByText(/1 of 1:/)).toBeInTheDocument();
    expect(within(bar).getByText(/camera saw the fingers close here, likely Pinch/)).toBeInTheDocument();
    expect(screen.getByText(/Selected 0\.300 s to 0\.500 s/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(within(screen.getByRole("list", { name: "By hand labels" })).getByRole("listitem")).toHaveAttribute("title", expect.stringMatching(/^Pinch: 0\.300 s to 0\.500 s/));
    expect(within(bar).getByText(/Reviewed them all/)).toBeInTheDocument();
  });

  it("snaps a selection's edge to where the fingers closed, unless Alt is held", async () => {
    const lanes = await openRecording();
    await screen.findByRole("region", { name: "Suggestions" });
    drag(lanes, 100, 295); // the fingers closed at 0.3 s, 5 px away
    expect(screen.getByText(/Selected 0\.100 s to 0\.300 s/)).toBeInTheDocument();
    fireEvent.pointerDown(lanes, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(lanes, { clientX: 295, pointerId: 1, altKey: true });
    fireEvent.pointerUp(lanes, { clientX: 295, pointerId: 1 });
    expect(screen.getByText(/Selected 0\.100 s to 0\.295 s/)).toBeInTheDocument();
  });

  it("steps to where a model and the labels disagree", async () => {
    await openRecording();
    const problems = screen.getByRole("region", { name: "Problems" });
    // The test recording has a sample every half second: each gap is a stall.
    expect(within(problems).getByText("3 places to check")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "]" });
    expect(within(problems).getByText(/At 0\.000 s: Pulse stopped for 0\.5 s/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run the active models" }));
    // The detection at 0.2 s follows no pinch start.
    await waitFor(() => expect(within(problems).getByText("4 places to check")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "]" });
    expect(within(problems).getByText(/At 0\.200 s: The Pinch model fired with no Pinch starting/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "[" });
    expect(within(problems).getByText(/At 0\.000 s: Pulse stopped/)).toBeInTheDocument();
  });

  it("marks the recording's labels as reviewed, or as needing work with a note", async () => {
    await openRecording();
    invoke.mockImplementationOnce(async (_command: string, args?: Record<string, unknown>) => ({ id: "d1", originalFilename: "pinch session", importedAt: "", label: "pinch", rowCount: 5, sequence: 3, review: { status: args?.status, note: args?.note ?? "", at: "2026-10-24T10:00:00Z" } }));
    const review = screen.getByRole("region", { name: "Review" });
    expect(within(review).getByText("Not reviewed yet.")).toBeInTheDocument();
    fireEvent.change(within(review).getByLabelText("What still needs doing"), { target: { value: "check the end" } });
    fireEvent.click(within(review).getByRole("button", { name: "Needs work" }));
    expect(invoke).toHaveBeenCalledWith("set_dataset_review", { id: "d1", status: "needs_work", note: "check the end" });
    await waitFor(() => expect(within(review).getByText(/Labels need work: check the end \(2026-10-24\)/)).toBeInTheDocument());
  });
});
