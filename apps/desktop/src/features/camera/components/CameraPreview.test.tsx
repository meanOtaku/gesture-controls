import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraController, CameraSnapshot } from "../cameraController";

vi.mock("../drawHands", () => ({ drawHands: vi.fn() }));

import { CameraPreview } from "./CameraPreview";

const state: CameraSnapshot = { status: "on", error: null, devices: [], deviceId: null, fps: 0, detectMs: 0, engine: null, frame: null, recordLandmarks: true, collecting: false, collectedFrames: 0, truncated: false };

beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as unknown as CanvasRenderingContext2D); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("CameraPreview", () => {
  it("shows the camera's own video while open, and keeps it in the document, out of sight, when closed", () => {
    const video = document.createElement("video");
    const camera = { video } as unknown as CameraController;
    const { container, unmount } = render(<CameraPreview camera={camera} state={state} hidden={false} />);
    expect(container.querySelector(".camera-stage")?.contains(video)).toBe(true);
    unmount();
    expect(video.isConnected).toBe(true); // a video removed from the document is paused by the browser
    expect(video.parentElement?.hasAttribute("data-camera-holder")).toBe(true);
  });

  it("gives the video back to the next page that shows it, and restarts it if it was paused", () => {
    const video = document.createElement("video");
    const play = vi.fn(async () => undefined);
    Object.defineProperty(video, "play", { value: play });
    Object.defineProperty(video, "srcObject", { value: {}, configurable: true });
    Object.defineProperty(video, "paused", { value: true, configurable: true });
    const camera = { video } as unknown as CameraController;
    render(<CameraPreview camera={camera} state={state} hidden={false} />).unmount();
    const second = render(<CameraPreview camera={camera} state={state} hidden={false} />);
    expect(second.container.querySelector(".camera-stage")?.contains(video)).toBe(true);
    expect(play).toHaveBeenCalled();
  });

  it("goes back to the page still showing it when a second preview of the same camera closes", () => {
    const video = document.createElement("video");
    const camera = { video } as unknown as CameraController;
    const page = render(<CameraPreview camera={camera} state={state} hidden={false} />);
    const quick = render(<CameraPreview camera={camera} state={state} hidden={false} />);
    expect(quick.container.querySelector(".camera-stage")?.contains(video)).toBe(true);
    quick.unmount(); // the quick preview closes; the Recorder page is still open
    expect(page.container.querySelector(".camera-stage")?.contains(video)).toBe(true);
    page.unmount();
    expect(video.parentElement?.hasAttribute("data-camera-holder")).toBe(true);
  });

  it("stays with the newest preview when an older one closes first", () => {
    const video = document.createElement("video");
    const camera = { video } as unknown as CameraController;
    const page = render(<CameraPreview camera={camera} state={state} hidden={false} />);
    const quick = render(<CameraPreview camera={camera} state={state} hidden={false} />);
    page.unmount();
    expect(quick.container.querySelector(".camera-stage")?.contains(video)).toBe(true);
  });
});
