import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraController, CameraSnapshot } from "../camera/cameraController";

vi.mock("../camera/drawHands", () => ({ drawHands: vi.fn() }));

import { CameraPair } from "./CameraPair";

const base: CameraSnapshot = { status: "off", error: null, devices: [], deviceId: null, fps: 0, frame: null, recordLandmarks: true, collecting: false, collectedFrames: 0, truncated: false };
const devices = [{ deviceId: "a", label: "FaceTime HD" }, { deviceId: "b", label: "Desk camera" }, { deviceId: "c", label: "Phone" }];
const fake = () => ({ video: document.createElement("video"), refreshDevices: vi.fn(async () => undefined), selectDevice: vi.fn() }) as unknown as CameraController;

beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as unknown as CanvasRenderingContext2D); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("CameraPair", () => {
  it("shows only the first camera's column until the first camera is on", () => {
    const { container } = render(<CameraPair primary={fake()} primaryState={base} secondary={fake()} secondaryState={base} />);
    expect(container.querySelectorAll(".camera-pair-item")).toHaveLength(1);
  });

  it("puts the second camera's choice beside the first's, leaving the first camera's device out of it", () => {
    const { container } = render(
      <CameraPair primary={fake()} primaryState={{ ...base, status: "on", devices, deviceId: "a" }} secondary={fake()} secondaryState={{ ...base, devices, deviceId: "b" }} />,
    );
    expect(container.querySelectorAll(".camera-pair-item")).toHaveLength(2);
    const second = screen.getByLabelText("Second camera");
    expect([...second.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Desk camera", "Phone"]);
  });

  it("names the first camera 'First camera' once a second one is running", () => {
    render(<CameraPair primary={fake()} primaryState={{ ...base, status: "on", devices, deviceId: "a" }} secondary={fake()} secondaryState={{ ...base, status: "on", devices, deviceId: "b" }} />);
    expect(screen.getByLabelText("First camera")).toBeInTheDocument();
  });
});
