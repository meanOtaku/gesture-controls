import { beforeEach, describe, expect, it, vi } from "vitest";

const feedback = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("../../components/app/OperationFeedback", () => ({ OperationFeedback: feedback }));

import { telemetryStore } from "../telemetry/store/telemetryStore";
import { cameraAssist } from "./cameraAssist";

beforeEach(() => {
  Object.values(feedback).forEach((fn) => fn.mockReset());
  cameraAssist.disarm();
  telemetryStore.reset();
});

describe("cameraAssist", () => {
  it("says how many intervals the camera marked while recording, for the armed label", () => {
    vi.spyOn(telemetryStore, "countCameraIntervals").mockReturnValue(2);
    cameraAssist.arm("pinch");
    expect(cameraAssist.armedFor()).toBe("pinch");
    cameraAssist.finish();
    expect(feedback.success).toHaveBeenCalledWith("Camera marking", expect.stringContaining("Marked 2 pinch intervals while recording"));
    expect(cameraAssist.armedFor()).toBeNull();
  });

  it("warns when the camera never saw the gesture, and says nothing unless armed", () => {
    vi.spyOn(telemetryStore, "countCameraIntervals").mockReturnValue(0);
    cameraAssist.arm("pinch");
    cameraAssist.finish();
    expect(feedback.warning).toHaveBeenCalledWith("Camera marking", expect.stringContaining("did not see the pinch gesture"));
    feedback.warning.mockReset();
    cameraAssist.finish(); // already consumed
    expect(feedback.warning).not.toHaveBeenCalled();
  });

  it("is cleared by disarm, so a discarded recording says nothing", () => {
    cameraAssist.arm("pinch");
    cameraAssist.disarm();
    cameraAssist.finish();
    expect(feedback.success).not.toHaveBeenCalled();
    expect(feedback.warning).not.toHaveBeenCalled();
  });
});

describe("cameraAssist defaults", () => {
  it("is on unless switched off, remembers the choice, and only takes effect when the card has checked it can work", () => {
    localStorage.removeItem("cameraMarkingOn");
    cameraAssist.setEnabled(true);
    expect(cameraAssist.isEnabled()).toBe(true);
    expect(cameraAssist.willMark("pinch")).toBe(false); // nothing has said it can work yet
    cameraAssist.setReady("pinch");
    expect(cameraAssist.willMark("pinch")).toBe(true);
    expect(cameraAssist.willMark("fist")).toBe(false); // a different label than the one checked
    expect(cameraAssist.willMark(null)).toBe(false);
    cameraAssist.setEnabled(false);
    expect(cameraAssist.willMark("pinch")).toBe(false);
    expect(localStorage.getItem("cameraMarkingOn")).toBe("0");
    cameraAssist.setEnabled(true);
    expect(localStorage.getItem("cameraMarkingOn")).toBe("1");
    cameraAssist.setReady(null);
  });
});

describe("cameraAssist with several labels", () => {
  it("marks only when exactly the checked labels are chosen, in any order", () => {
    cameraAssist.setEnabled(true);
    cameraAssist.setReady(["pinch", "fist"]);
    expect(cameraAssist.willMark(["fist", "pinch"])).toBe(true);
    expect(cameraAssist.willMark(["pinch"])).toBe(false);
    expect(cameraAssist.willMark(["pinch", "fist", "wave"])).toBe(false);
    cameraAssist.setReady(null);
  });

  it("reports what the camera marked for each label, and names the one it never saw", () => {
    vi.spyOn(telemetryStore, "countCameraIntervals").mockImplementation((label) => (label === "pinch" ? 3 : 0));
    cameraAssist.arm(["pinch", "wrist_flick"]);
    expect(cameraAssist.armedForAll()).toEqual(["pinch", "wrist_flick"]);
    cameraAssist.finish();
    expect(feedback.warning).toHaveBeenCalledWith("Camera marking", expect.stringMatching(/Marked 3 pinch.*did not see wrist flick/));
  });

  it("is a success when every label was seen", () => {
    vi.spyOn(telemetryStore, "countCameraIntervals").mockReturnValue(1);
    cameraAssist.arm(["pinch", "fist"]);
    cameraAssist.finish();
    expect(feedback.success).toHaveBeenCalledWith("Camera marking", expect.stringContaining("Marked 1 pinch, 1 fist"));
  });
});
