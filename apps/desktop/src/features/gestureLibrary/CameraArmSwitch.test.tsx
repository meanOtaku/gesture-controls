import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraController } from "../camera/cameraController";
import type { HandDetector } from "../camera/handTypes";

const holder = vi.hoisted(() => ({ controller: null as unknown }));
vi.mock("../camera/cameraService", () => ({ getCameraController: () => holder.controller }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { CameraArmSwitch } from "./CameraArmSwitch";

let next: (() => void) | null = null;
function makeController() {
  const video = document.createElement("video");
  Object.defineProperty(video, "play", { value: vi.fn(async () => undefined) });
  Object.defineProperty(video, "requestVideoFrameCallback", { value: (cb: (n: number, m?: { captureTime?: number }) => void) => { next = () => cb(1000, { captureTime: 1000 }); return 1; } });
  const detector: HandDetector = { detect: () => [], close: () => undefined };
  return new CameraController({
    getUserMedia: vi.fn(async () => ({ getTracks: () => [], getVideoTracks: () => [{ getSettings: () => ({ width: 640, height: 480 }) }] }) as unknown as MediaStream),
    enumerateDevices: vi.fn(async () => []), createDetector: vi.fn(async () => detector), createVideo: () => video, now: () => 0, syncPairs: () => [],
  });
}

beforeEach(() => { next = null; holder.controller = makeController(); invoke.mockReset(); invoke.mockResolvedValue({}); });
afterEach(() => cleanup());

describe("CameraArmSwitch", () => {
  it("cannot be armed with the camera off, and offers to turn the camera on", () => {
    render(<CameraArmSwitch armed={false} />);
    expect(screen.getByRole("switch", { name: "Arm camera gestures" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/Recipes with a camera gesture will not act until then/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn camera on" })).toBeInTheDocument();
  });

  it("arms through the desktop once the camera is on, and shows the desktop's refusal", async () => {
    render(<CameraArmSwitch armed={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn camera on" }));
    await waitFor(() => expect(next).not.toBeNull());
    await act(async () => { next?.(); });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Arm camera gestures" })).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(screen.getByRole("switch", { name: "Arm camera gestures" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_camera_armed", { armed: true }));

    invoke.mockRejectedValueOnce("turn the camera on first");
    fireEvent.click(screen.getByRole("switch", { name: "Arm camera gestures" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("turn the camera on first");
  });

  it("says when it is armed and can be switched off even if the camera has stopped", () => {
    render(<CameraArmSwitch armed />);
    expect(screen.getByText("Camera gestures armed")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Arm camera gestures" })).not.toHaveAttribute("aria-disabled", "true");
  });
});
