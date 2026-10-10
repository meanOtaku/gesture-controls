import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryStore } from "../../telemetry/store/telemetryStore";
import { CameraController, type CameraDeps } from "../cameraController";
import { clockSync } from "../clockSync";
import type { HandDetector, Point3, TrackedHand } from "../handTypes";

const holder = vi.hoisted(() => ({ controller: null as unknown, second: null as unknown }));
vi.mock("../cameraService", () => ({ getCameraController: (slot?: string) => (slot === "secondary" ? holder.second : holder.controller) }));
vi.mock("../drawHands", () => ({ drawHands: vi.fn() }));

import { CameraCapturePanel } from "./CameraCapturePanel";

const open = (): Point3[] => {
  const p: Point3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  p[9] = { x: 0, y: -0.09, z: 0 };
  p[4] = { x: 0.05, y: -0.05, z: 0 };
  p[8] = { x: 0.05, y: -0.1, z: 0 };
  return p;
};
const hand = (): TrackedHand => ({ modelHandedness: "Left", score: 0.93, image: open(), world: open() });

let hands: TrackedHand[] = [];
let devices: { kind: string; deviceId: string; label: string }[] = [];
let next: (() => void) | null = null;

function makeController(over: Partial<CameraDeps> = {}) {
  const video = document.createElement("video");
  Object.defineProperty(video, "play", { value: vi.fn(async () => undefined) });
  Object.defineProperty(video, "requestVideoFrameCallback", { value: (cb: (now: number, m?: { captureTime?: number }) => void) => { next = () => cb(1000, { captureTime: 1000 }); return 1; } });
  const detector: HandDetector = { detect: () => hands, close: () => undefined };
  const deps = {
    getUserMedia: vi.fn(async () => ({ getTracks: () => [], getVideoTracks: () => [{ getSettings: () => ({ width: 640, height: 480, deviceId: "a" }) }] }) as unknown as MediaStream),
    enumerateDevices: vi.fn(async () => devices as MediaDeviceInfo[]),
    createDetector: vi.fn(async () => detector),
    createVideo: () => video,
    now: () => 0,
    syncPairs: () => [],
    ...over,
  };
  const controller = new CameraController(deps);
  holder.controller = controller;
  // The second camera is its own, separate camera: off unless a test turns it on.
  holder.second = new CameraController({ ...deps, slot: "secondary", createVideo: () => document.createElement("video") });
  return controller;
}

beforeEach(() => { telemetryStore.reset(); clockSync.reset(); hands = []; devices = [{ kind: "videoinput", deviceId: "a", label: "FaceTime HD" }]; next = null; });
afterEach(() => cleanup());

const region = () => within(screen.getByRole("region", { name: "Camera hand tracking" }));

describe("CameraCapturePanel", () => {
  it("starts off, says so, and explains what is saved", () => {
    makeController();
    render(<CameraCapturePanel />);
    expect(region().getByText(/The camera is off/)).toBeInTheDocument();
    expect(region().getByRole("button", { name: "Turn camera on" })).toBeInTheDocument();
    expect(region().getByText(/never the picture/)).toBeInTheDocument();
    expect(region().getByRole("checkbox", { name: "Save hand landmarks with recordings" })).toBeChecked();
  });

  it("turns the camera on and off", async () => {
    const controller = makeController();
    render(<CameraCapturePanel />);
    await act(async () => { fireEvent.click(region().getByRole("button", { name: "Turn camera on" })); });
    expect(controller.getSnapshot().status).toBe("on");
    expect(await region().findByRole("button", { name: "Turn camera off" })).toBeInTheDocument();
    act(() => fireEvent.click(region().getByRole("button", { name: "Turn camera off" })));
    expect(controller.getSnapshot().status).toBe("off");
  });

  it("tells you what is happening while the camera starts, including that a permission prompt may appear", async () => {
    let finish: (() => void) | null = null;
    makeController({ getUserMedia: vi.fn(() => new Promise<MediaStream>(() => { finish = () => undefined; })) });
    render(<CameraCapturePanel />);
    await act(async () => { fireEvent.click(region().getByRole("button", { name: "Turn camera on" })); });
    expect(region().getByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(region().getByText(/allow it/)).toBeInTheDocument();
    expect(finish).not.toBeNull();
  });

  it("says why the camera could not be used", async () => {
    makeController({ getUserMedia: vi.fn(async () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); }) });
    render(<CameraCapturePanel />);
    await act(async () => { fireEvent.click(region().getByRole("button", { name: "Turn camera on" })); });
    expect(await region().findByRole("alert")).toHaveTextContent("The camera was blocked");
    expect(region().getByRole("button", { name: "Turn camera on" })).toBeInTheDocument();
  });

  it("shows what the camera sees: no hand, then a hand, its side and the thumb-to-index distance", async () => {
    makeController();
    render(<CameraCapturePanel />);
    await act(async () => { fireEvent.click(region().getByRole("button", { name: "Turn camera on" })); });
    act(() => next?.());
    expect(region().getByText("No hand in view")).toBeInTheDocument();
    hands = [hand()];
    act(() => next?.());
    expect(region().getByText("1 hand")).toBeInTheDocument();
    expect(region().getByText("Left hand · 93%")).toBeInTheDocument();
    expect(region().getByRole("meter", { name: "Thumb to index distance, Left hand" })).toBeInTheDocument();
    expect(region().getByText("0.56 hand sizes")).toBeInTheDocument();
  });

  it("lets you choose between cameras, and only when there is a choice", async () => {
    devices = [{ kind: "videoinput", deviceId: "a", label: "FaceTime HD" }, { kind: "videoinput", deviceId: "b", label: "Desk camera" }];
    makeController();
    render(<CameraCapturePanel />);
    await act(async () => { fireEvent.click(region().getByRole("button", { name: "Turn camera on" })); });
    const select = await region().findByLabelText("Camera");
    expect(within(select).getByRole("option", { name: "Desk camera" })).toBeInTheDocument();
  });

  it("switches saving landmarks off and on", () => {
    const controller = makeController();
    render(<CameraCapturePanel />);
    fireEvent.click(region().getByRole("checkbox", { name: "Save hand landmarks with recordings" }));
    expect(controller.getSnapshot().recordLandmarks).toBe(false);
  });

  it("reports the state of the clock alignment, and of an active recording", async () => {
    const controller = makeController();
    render(<CameraCapturePanel />);
    expect(region().getByRole("status")).toHaveTextContent("starts once the watch is streaming");
    await act(async () => { fireEvent.click(region().getByRole("button", { name: "Turn camera on" })); });
    for (let i = 0; i < 30; i += 1) clockSync.observe((1_000_000_000 + i * 20_000_000), 5000 + i * 20);
    telemetryStore.ingestWatchStatus({ connected: true } as never);
    act(() => controller.setRecordLandmarks(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(region().getByRole("status").textContent).toMatch(/Clock alignment with the watch/);
    act(() => { hands = [hand()]; controller.syncRecording("recording"); next?.(); });
    expect(region().getByRole("status")).toHaveTextContent(/Recording the camera: \d+ frames kept/);
  });
});
