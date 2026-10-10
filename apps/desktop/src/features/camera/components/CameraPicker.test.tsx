import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CameraController, CameraSnapshot } from "../cameraController";
import { CameraPicker } from "./CameraPicker";

afterEach(() => cleanup());

const state = (devices: { deviceId: string; label: string }[], deviceId: string | null = "a"): CameraSnapshot => ({
  status: "off", error: null, devices, deviceId, fps: 0, frame: null, recordLandmarks: true, collecting: false, collectedFrames: 0, truncated: false,
});
const fake = () => ({ refreshDevices: vi.fn(async () => undefined), selectDevice: vi.fn() }) as unknown as CameraController & { refreshDevices: ReturnType<typeof vi.fn>; selectDevice: ReturnType<typeof vi.fn> };

describe("CameraPicker", () => {
  it("offers nothing when there is only one camera", () => {
    const { container } = render(<CameraPicker camera={fake()} state={state([{ deviceId: "a", label: "FaceTime HD" }])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the cameras, reads the list when it opens, and passes the choice on", () => {
    const camera = fake();
    render(<CameraPicker camera={camera} state={state([{ deviceId: "a", label: "FaceTime HD" }, { deviceId: "b", label: "Desk camera" }])} />);
    expect(camera.refreshDevices).toHaveBeenCalled();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["FaceTime HD", "Desk camera"]);
    fireEvent.change(screen.getByLabelText("Camera"), { target: { value: "b" } });
    expect(camera.selectDevice).toHaveBeenCalledWith("b");
  });
});
