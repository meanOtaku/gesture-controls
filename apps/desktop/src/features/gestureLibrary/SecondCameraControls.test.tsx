import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraController, CameraSnapshot } from "../camera/cameraController";

vi.mock("../camera/drawHands", () => ({ drawHands: vi.fn() }));

import { SecondCameraControls } from "./SecondCameraControls";

const base: CameraSnapshot = { status: "off", error: null, devices: [], deviceId: null, fps: 0, frame: null, recordLandmarks: true, collecting: false, collectedFrames: 0, truncated: false };
const devices = [{ deviceId: "a", label: "FaceTime HD" }, { deviceId: "b", label: "Desk camera" }];
const fake = () => {
  const video = document.createElement("video");
  return { video, refreshDevices: vi.fn(async () => undefined), selectDevice: vi.fn(), enable: vi.fn(async () => undefined), disable: vi.fn() } as unknown as CameraController & Record<string, ReturnType<typeof vi.fn>>;
};

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("SecondCameraControls", () => {
  it("asks for the first camera before anything else", () => {
    render(<SecondCameraControls primary={fake()} primaryState={base} secondary={fake()} secondaryState={base} />);
    expect(screen.getByText("Turn the first camera on first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn second camera on" })).toBeDisabled();
  });

  it("says when there is no other camera, and otherwise starts the first one the primary is not using", () => {
    const secondary = fake();
    const { rerender } = render(<SecondCameraControls primary={fake()} primaryState={{ ...base, status: "on", devices: [devices[0]], deviceId: "a" }} secondary={secondary} secondaryState={base} />);
    expect(screen.getByText(/No other camera was found/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn second camera on" })).toBeDisabled();
    rerender(<SecondCameraControls primary={fake()} primaryState={{ ...base, status: "on", devices, deviceId: "a" }} secondary={secondary} secondaryState={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn second camera on" }));
    expect(secondary.enable).toHaveBeenCalledWith("b");
  });

  it("shows both cameras' status and says how their decisions combine, once it is on", () => {
    const secondary = fake();
    render(<SecondCameraControls primary={fake()} primaryState={{ ...base, status: "on", devices, deviceId: "a", fps: 30 }} secondary={secondary} secondaryState={{ ...base, status: "on", devices, deviceId: "b", fps: 28 }} />);
    expect(screen.getByText("28 frames/s")).toBeInTheDocument();
    expect(screen.getByText("First camera: 30 frames/s")).toBeInTheDocument();
    expect(screen.getByText(/marked when either camera sees it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn second camera off" }));
    expect(secondary.disable).toHaveBeenCalled();
  });
});
