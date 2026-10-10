import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clockSyncCsv, frameToCsvRows, handLandmarksHeader } from "../camera/handLandmarkCsv";
import { blankDefinition, type GestureDefinition } from "./definition";
import { makeHand } from "./testHands";

const api = vi.hoisted(() => ({ onRecordingsChanged: vi.fn(),
  listRecordingBundles: vi.fn(), loadRecordingBundle: vi.fn(), getRecordingCameraEvidence: vi.fn(), addCameraProposedIntervals: vi.fn(),
}));
vi.mock("../../shared/tauri/recordingBundle", () => api);
const library = vi.hoisted(() => ({ listGestureDefinitions: vi.fn() }));
vi.mock("./gestureLibraryApi", () => library);

import { CameraProposalsPanel } from "./CameraProposalsPanel";

const pinch: GestureDefinition = {
  ...blankDefinition(), id: "g1", name: "Pinch", labelId: "pinch",
  conditions: [{ measure: "pinch.index", direction: "below", enter: 0.3, exit: 0.5 }],
};
const frames = Array.from({ length: 90 }, (_, i) => ({ frameIndex: i, captureMs: 10_000 + i * 33.333, hands: [makeHand({ pinch: i >= 30 && i < 60 ? 0.1 : 1.2 })] }));
const evidence = {
  handLandmarks: [handLandmarksHeader(), ...frames.flatMap(frameToCsvRows)].join("\n"),
  clockSync: clockSyncCsv(Array.from({ length: 20 }, (_, i) => ({ watchTimestampNs: (6000 + i * 200) * 1e6, browserArrivalMs: 10_000 + i * 200 }))),
  rawTimestampsNs: Array.from({ length: 200 }, (_, i) => (6000 + i * 20) * 1e6),
};
const bundle = { recordingId: "rec-1", rawRowCount: 200, intervalCount: 0, actualDurationMs: 4000 };

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.onRecordingsChanged.mockReturnValue(() => undefined);
  library.listGestureDefinitions.mockResolvedValue([pinch]);
  api.listRecordingBundles.mockResolvedValue({ status: "ok", value: [bundle] });
  api.loadRecordingBundle.mockResolvedValue({ status: "ok", value: { recording: {}, annotations: { intervals: [] } } });
  api.getRecordingCameraEvidence.mockResolvedValue({ status: "ok", value: evidence });
  api.addCameraProposedIntervals.mockResolvedValue({ status: "ok", value: [] });
});
afterEach(() => cleanup());

const choose = async () => {
  await screen.findByRole("option", { name: /rec-1/ });
  fireEvent.change(screen.getByLabelText("Recording"), { target: { value: "rec-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Find gestures" }));
};

describe("CameraProposalsPanel", () => {
  it("finds the gesture, shows when, and adds only the chosen intervals as camera proposals", async () => {
    render(<CameraProposalsPanel />);
    await choose();
    const box = await screen.findByRole("checkbox", { name: /Pinch at/ });
    expect(screen.getByRole("status").textContent).toMatch(/lined up to within about/);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 as unreviewed" }));
    await waitFor(() => expect(api.addCameraProposedIntervals).toHaveBeenCalled());
    const [id, intervals] = api.addCameraProposedIntervals.mock.calls[0];
    expect(id).toBe("rec-1");
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({ label_id: "pinch", creation_mechanism: "camera_proposal", curation_status: "unreviewed" });
    expect(box).toBeTruthy();
  });

  it("says so when the recording has no camera data, or no gesture has a label", async () => {
    api.getRecordingCameraEvidence.mockResolvedValue({ status: "ok", value: null });
    render(<CameraProposalsPanel />);
    await choose();
    expect(await screen.findByText(/no camera data/)).toBeTruthy();
    cleanup();
    api.getRecordingCameraEvidence.mockResolvedValue({ status: "ok", value: evidence });
    library.listGestureDefinitions.mockResolvedValue([{ ...pinch, labelId: null }]);
    render(<CameraProposalsPanel />);
    await choose();
    expect(await screen.findByText(/linked to a label/)).toBeTruthy();
  });

  it("will not offer a proposal that overlaps an interval already in the recording", async () => {
    api.loadRecordingBundle.mockResolvedValue({
      status: "ok",
      value: { recording: {}, annotations: { intervals: [{ resolved_start: { raw_row: 0 }, resolved_end: { raw_row: 199 } }] } },
    });
    render(<CameraProposalsPanel />);
    await choose();
    const box = await screen.findByRole("checkbox", { name: /Pinch at/ });
    expect(box.getAttribute("aria-disabled") === "true" || box.hasAttribute("disabled") || box.getAttribute("data-disabled") !== null).toBe(true);
    expect(screen.getByText(/Overlaps an interval already there/)).toBeTruthy();
  });

  it("refreshes its list when recordings change elsewhere, and lets go of a recording that was deleted", async () => {
    let changed: () => void = () => undefined;
    api.onRecordingsChanged.mockImplementation((listener: () => void) => { changed = listener; return () => undefined; });
    render(<CameraProposalsPanel />);
    await screen.findByRole("option", { name: /rec-1/ });
    fireEvent.change(screen.getByLabelText("Recording"), { target: { value: "rec-1" } });
    api.listRecordingBundles.mockResolvedValue({ status: "ok", value: [] }); // it was deleted in the viewer below
    changed();
    await waitFor(() => expect(screen.queryByRole("option", { name: /rec-1/ })).toBeNull());
    expect((screen.getByLabelText("Recording") as HTMLSelectElement).value).toBe("");
  });

  it("says a recording is no longer there, in words, instead of showing the file error", async () => {
    api.getRecordingCameraEvidence.mockResolvedValue({ status: "error", message: "No such file or directory (os error 2)" });
    render(<CameraProposalsPanel />);
    await choose();
    expect(await screen.findByText(/no longer there/)).toBeInTheDocument();
    expect(screen.queryByText(/os error 2/)).toBeNull();
  });
});
