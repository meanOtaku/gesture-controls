import { beforeEach, describe, expect, it, vi } from "vitest";
import { clockSyncCsv, frameToCsvRows, handLandmarksHeader } from "../camera/handLandmarkCsv";
import { blankDefinition, type GestureDefinition } from "./definition";
import { makeHand } from "./testHands";

const api = vi.hoisted(() => ({ loadRecordingBundle: vi.fn(), getRecordingCameraEvidence: vi.fn(), addCameraProposedIntervals: vi.fn() }));
vi.mock("../../shared/tauri/recordingBundle", () => api);
const library = vi.hoisted(() => ({ listGestureDefinitions: vi.fn() }));
vi.mock("./gestureLibraryApi", () => library);
const feedback = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("../../components/app/OperationFeedback", () => ({ OperationFeedback: feedback }));

import { cameraAssist } from "./cameraAssist";

const pinch: GestureDefinition = { ...blankDefinition(), id: "g1", name: "Pinch", labelId: "pinch", conditions: [{ measure: "pinch.index", direction: "below", enter: 0.3, exit: 0.5 }] };
const other: GestureDefinition = { ...pinch, id: "g2", name: "Fist", labelId: "fist" };
const frames = (held: boolean) => Array.from({ length: 90 }, (_, i) => ({ frameIndex: i, captureMs: 10_000 + i * 33.333, hands: [makeHand({ pinch: held && i >= 30 && i < 60 ? 0.1 : 1.2 })] }));
const evidence = (held: boolean) => ({
  handLandmarks: [handLandmarksHeader(), ...frames(held).flatMap(frameToCsvRows)].join("\n"),
  clockSync: clockSyncCsv(Array.from({ length: 20 }, (_, i) => ({ watchTimestampNs: (6000 + i * 200) * 1e6, browserArrivalMs: 10_000 + i * 200 }))),
  rawTimestampsNs: Array.from({ length: 200 }, (_, i) => (6000 + i * 20) * 1e6),
});

beforeEach(() => {
  Object.values({ ...api, ...feedback }).forEach((fn) => fn.mockReset());
  library.listGestureDefinitions.mockResolvedValue([pinch, other]);
  api.loadRecordingBundle.mockResolvedValue({ status: "ok", value: { recording: {}, annotations: { intervals: [] } } });
  api.addCameraProposedIntervals.mockResolvedValue({ status: "ok", value: [] });
  cameraAssist.disarm();
});

describe("cameraAssist", () => {
  it("marks the armed label's gesture once the recording is saved, using only that label's gestures", async () => {
    api.getRecordingCameraEvidence.mockResolvedValue({ status: "ok", value: evidence(true) });
    cameraAssist.arm("pinch");
    await cameraAssist.finish("rec-1");
    const [id, intervals] = api.addCameraProposedIntervals.mock.calls[0];
    expect(id).toBe("rec-1");
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({ label_id: "pinch", creation_mechanism: "camera_proposal", curation_status: "unreviewed" });
    expect(feedback.success).toHaveBeenCalledWith("Camera marking", expect.stringContaining("Marked 1 pinch hold"));
  });

  it("also marks the closing and opening stretches when the gesture asks for them, under their own labels", async () => {
    library.listGestureDefinitions.mockResolvedValue([{ ...pinch, closePhase: { labelId: "pinch_close", ms: 500 }, openPhase: { labelId: "pinch_open", ms: 500 } }, other]);
    api.getRecordingCameraEvidence.mockResolvedValue({ status: "ok", value: evidence(true) });
    cameraAssist.arm("pinch");
    await cameraAssist.finish("rec-1");
    const intervals = api.addCameraProposedIntervals.mock.calls[0][1] as { label_id: string }[];
    expect(intervals.map((i) => i.label_id)).toEqual(["pinch_close", "pinch", "pinch_open"]);
    expect(feedback.success).toHaveBeenCalledWith("Camera marking", expect.stringContaining("Marked 1 pinch hold with 1 closing and 1 opening stretch"));
  });

  it("marks a gesture only the second camera saw, using the file the recording kept for it", async () => {
    api.getRecordingCameraEvidence.mockResolvedValue({
      status: "ok",
      value: { ...evidence(false), handLandmarksSecond: evidence(true).handLandmarks },
    });
    cameraAssist.arm("pinch");
    await cameraAssist.finish("rec-1");
    const intervals = api.addCameraProposedIntervals.mock.calls[0][1] as { label_id: string }[];
    expect(intervals.map((i) => i.label_id)).toEqual(["pinch"]);
    expect(feedback.success).toHaveBeenCalledWith("Camera marking", expect.stringContaining("Marked 1 pinch hold"));
  });

  it("treats a gesture's closing or opening label as that gesture, so choosing it still marks the whole gesture", async () => {
    library.listGestureDefinitions.mockResolvedValue([{ ...pinch, closePhase: { labelId: "pinch_close", ms: 500 }, openPhase: { labelId: "pinch_open", ms: 500 } }, other]);
    api.getRecordingCameraEvidence.mockResolvedValue({ status: "ok", value: evidence(true) });
    cameraAssist.arm("pinch_open");
    await cameraAssist.finish("rec-1");
    const intervals = api.addCameraProposedIntervals.mock.calls[0][1] as { label_id: string }[];
    expect(intervals.map((i) => i.label_id)).toEqual(["pinch_close", "pinch", "pinch_open"]);
  });

  it("keeps the recording and says so when the camera never saw the gesture", async () => {
    api.getRecordingCameraEvidence.mockResolvedValue({ status: "ok", value: evidence(false) });
    cameraAssist.arm("pinch");
    await cameraAssist.finish("rec-1");
    expect(api.addCameraProposedIntervals).not.toHaveBeenCalled();
    expect(feedback.warning).toHaveBeenCalledWith("Camera marking", expect.stringContaining("did not see the pinch gesture"));
  });

  it("explains why nothing was marked when the recording has no camera data, and does nothing unless armed", async () => {
    api.getRecordingCameraEvidence.mockResolvedValue({ status: "ok", value: null });
    cameraAssist.arm("pinch");
    await cameraAssist.finish("rec-1");
    expect(feedback.warning).toHaveBeenCalledWith("Camera marking", expect.stringContaining("no camera data"));
    feedback.warning.mockReset();
    await cameraAssist.finish("rec-2"); // already consumed
    expect(feedback.warning).not.toHaveBeenCalled();
    expect(api.addCameraProposedIntervals).not.toHaveBeenCalled();
  });

  it("is cleared by disarm, so a discarded recording marks nothing", async () => {
    cameraAssist.arm("pinch");
    cameraAssist.disarm();
    await cameraAssist.finish("rec-1");
    expect(api.getRecordingCameraEvidence).not.toHaveBeenCalled();
  });
});
