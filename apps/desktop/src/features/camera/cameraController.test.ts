import { describe, expect, it, vi } from "vitest";
import { CameraController, EVIDENCE_MARGIN_MS, MAX_RECORDED_FRAMES, PREROLL_MS, type CameraDeps } from "./cameraController";
import type { HandDetector, Point3, TrackedHand } from "./handTypes";

const points = (): Point3[] => Array.from({ length: 21 }, (_, i) => ({ x: 0.5, y: 0.5 + i / 100, z: 0 }));
const aHand = (): TrackedHand => ({ modelHandedness: "Left", score: 0.95, image: points(), world: points() });

function setup(over: Partial<CameraDeps> & { hands?: () => TrackedHand[]; failDetector?: boolean } = {}) {
  const stopped: string[] = [];
  const timestamps: number[] = [];
  let pending: ((now: number, metadata?: { captureTime?: number }) => void) | null = null;
  const video = {
    srcObject: null as unknown,
    muted: false,
    playsInline: false,
    videoWidth: 640,
    videoHeight: 480,
    play: vi.fn(async () => undefined),
    requestVideoFrameCallback: vi.fn((callback: (now: number, metadata?: { captureTime?: number }) => void) => { pending = callback; return 1; }),
    remove: vi.fn(),
  } as unknown as HTMLVideoElement;
  const closed = { count: 0 };
  const detector: HandDetector = {
    detect: (_source, timestampMs) => { timestamps.push(timestampMs); return over.hands ? over.hands() : [aHand()]; },
    close: () => { closed.count += 1; },
  };
  const deps: CameraDeps = {
    getUserMedia: vi.fn(async () => ({
      getTracks: () => [{ stop: () => stopped.push("track") }],
      getVideoTracks: () => [{ getSettings: () => ({ width: 640, height: 480, deviceId: "cam-1" }) }],
    }) as unknown as MediaStream),
    enumerateDevices: vi.fn(async () => [
      { kind: "videoinput", deviceId: "cam-1", label: "FaceTime HD" },
      { kind: "audioinput", deviceId: "mic", label: "Mic" },
      { kind: "videoinput", deviceId: "cam-2", label: "" },
    ] as MediaDeviceInfo[]),
    createDetector: over.failDetector ? vi.fn(async () => { throw new Error("model file missing"); }) : vi.fn(async () => detector),
    createVideo: () => video,
    now: () => 0,
    syncPairs: vi.fn((from: number, to: number) => [{ watchTimestampNs: 1e9, browserArrivalMs: (from + to) / 2 }]),
    ...over,
  };
  const camera = new CameraController(deps);
  /** One camera frame at `ms`, as the browser would deliver it. */
  const frame = (ms: number, captureTime?: number) => { const run = pending; pending = null; run?.(ms, captureTime === undefined ? undefined : { captureTime }); };
  return { camera, deps, frame, stopped, timestamps, closed, video };
}

describe("CameraController", () => {
  it("turns on, lists the cameras, and reports each frame", async () => {
    const { camera, deps, frame } = setup();
    await camera.enable();
    const snap = camera.getSnapshot();
    expect(snap.status).toBe("on");
    expect(snap.devices).toEqual([{ deviceId: "cam-1", label: "FaceTime HD" }, { deviceId: "cam-2", label: "Camera 2" }]);
    expect(snap.deviceId).toBe("cam-1");
    expect((deps.getUserMedia as ReturnType<typeof vi.fn>).mock.calls[0][0].audio).toBe(false);
    frame(1000);
    frame(1033);
    frame(1066);
    expect(camera.getSnapshot().frame?.frameIndex).toBe(2);
    expect(camera.getSnapshot().frame?.hands).toHaveLength(1);
    expect(camera.getSnapshot().fps).toBeGreaterThan(25);
    expect(camera.getSnapshot().fps).toBeLessThan(35);
  });

  it("uses the camera chosen while it is off the next time it is turned on, and switches at once while it is on", async () => {
    const { camera, deps } = setup();
    const constraintsOf = (call: number) => (deps.getUserMedia as ReturnType<typeof vi.fn>).mock.calls[call][0].video;
    await camera.refreshDevices();
    camera.selectDevice("cam-2"); // off: only remembered
    expect(camera.getSnapshot().status).toBe("off");
    expect(camera.getSnapshot().deviceId).toBe("cam-2");
    expect(deps.getUserMedia).not.toHaveBeenCalled();
    await camera.enable();
    expect(constraintsOf(0).deviceId).toEqual({ exact: "cam-2" });
    camera.selectDevice("cam-1"); // on: switches now
    await vi.waitFor(() => expect(deps.getUserMedia).toHaveBeenCalledTimes(2));
    expect(constraintsOf(1).deviceId).toEqual({ exact: "cam-1" });
  });

  it("stamps a frame with the camera's own capture time when it has one, and the callback time when it does not", async () => {
    const { camera, frame } = setup();
    await camera.enable();
    frame(1000, 985);
    expect(camera.getSnapshot().frame?.captureMs).toBe(985);
    frame(1100);
    expect(camera.getSnapshot().frame?.captureMs).toBe(1100);
  });

  it("gives the detector a strictly increasing whole-millisecond clock, even if two frames share a time", async () => {
    const { camera, frame, timestamps } = setup();
    await camera.enable();
    frame(1000.4);
    frame(1000.4);
    frame(999);
    expect(timestamps).toEqual([1000, 1001, 1002]);
  });

  it.each([
    ["NotAllowedError", /blocked/],
    ["NotFoundError", /No camera/],
    ["NotReadableError", /in use by another app/],
  ])("explains %s in words and ends in the error state with the camera released", async (name, text) => {
    const { camera } = setup({ getUserMedia: vi.fn(async () => { throw Object.assign(new Error("x"), { name }); }) });
    await camera.enable();
    expect(camera.getSnapshot().status).toBe("error");
    expect(camera.getSnapshot().error).toMatch(text);
  });

  it("says when the hand model could not be loaded and lets go of the camera", async () => {
    const { camera, stopped } = setup({ failDetector: true });
    await camera.enable();
    expect(camera.getSnapshot().status).toBe("error");
    expect(camera.getSnapshot().error).toBe("The hand model could not be loaded: model file missing");
    expect(stopped).toContain("track");
  });

  it("turns off cleanly: stops the camera and closes the detector, and ignores frames still in flight", async () => {
    const { camera, frame, stopped, closed } = setup();
    await camera.enable();
    frame(1000);
    camera.disable();
    expect(stopped).toContain("track");
    expect(closed.count).toBe(1);
    expect(camera.getSnapshot()).toMatchObject({ status: "off", frame: null, fps: 0 });
    frame(1033);
    expect(camera.getSnapshot().frame).toBeNull();
  });

  it("a stopped detector mid-run ends in an error instead of silently freezing", async () => {
    let calls = 0;
    const { camera, frame } = setup({ hands: () => { calls += 1; if (calls === 2) throw new Error("GPU lost"); return []; } });
    await camera.enable();
    frame(1000);
    frame(1033);
    expect(camera.getSnapshot()).toMatchObject({ status: "error", error: "Hand tracking stopped: GPU lost" });
  });
});

describe("CameraController evidence", () => {
  async function recordingSetup(hands: () => TrackedHand[] = () => [aHand()]) {
    const ctx = setup({ hands });
    await ctx.camera.enable();
    return ctx;
  }

  it("keeps only a few seconds before a recording, and starts a recording with them", async () => {
    const { camera, frame } = await recordingSetup();
    for (let t = 0; t <= 6000; t += 100) frame(t);
    camera.syncRecording("recording");
    // 3 s of pre-roll at 10 frames a second: about 30, not the 60 seen.
    const kept = camera.getSnapshot().collectedFrames;
    expect(kept).toBeGreaterThanOrEqual(30);
    expect(kept).toBeLessThanOrEqual(32);
    expect(PREROLL_MS).toBe(3000);
  });

  it("builds the evidence for the recording's window with a margin either side, and declares its source", async () => {
    const { camera, frame, deps } = await recordingSetup();
    camera.syncRecording("arming");
    for (let t = 10_000; t <= 20_000; t += 50) frame(t);
    camera.syncRecording("recording");
    const evidence = camera.evidence(12_000, 18_000)!;
    const lines = evidence.files["hand_landmarks.csv"].split("\n");
    expect(lines[0].startsWith("frame_index,capture_ms,hand_index,hand_count,")).toBe(true);
    const times = lines.slice(1).map((line) => Number(line.split(",")[1]));
    expect(Math.min(...times)).toBeGreaterThanOrEqual(12_000 - EVIDENCE_MARGIN_MS);
    expect(Math.max(...times)).toBeLessThanOrEqual(18_000 + EVIDENCE_MARGIN_MS);
    expect(times.length).toBe(((18_000 + EVIDENCE_MARGIN_MS) - (12_000 - EVIDENCE_MARGIN_MS)) / 50 + 1);
    expect(evidence.files["clock_sync.csv"].split("\n")[0]).toBe("watch_timestamp_ns,browser_arrival_ms");
    expect(deps.syncPairs).toHaveBeenCalledWith(11_000, 19_000);
    expect(evidence.source.source_id).toBe("camera_hand_landmarks");
    expect(evidence.source.configuration).toMatchObject({
      runtime: "@mediapipe/tasks-vision", frames: times.length, frames_with_a_hand: times.length, truncated: false,
      handedness_convention: "model_label_assumes_mirrored_picture", picture: { width: 640, height: 480 },
    });
  });

  it("records frames with no hand as frames with no hand, and counts them apart", async () => {
    const { camera, frame } = await recordingSetup(() => []);
    camera.syncRecording("recording");
    for (let t = 0; t < 1000; t += 100) frame(t);
    const evidence = camera.evidence(0, 900)!;
    expect(evidence.source.configuration).toMatchObject({ frames: 10, frames_with_a_hand: 0 });
    const rows = evidence.files["hand_landmarks.csv"].split("\n").slice(1);
    expect(rows).toHaveLength(10);
    expect(rows[0].split(",").slice(2, 4)).toEqual(["", "0"]);
  });

  it("has no evidence when the camera was off, landmarks are switched off, or nothing fell in the window", async () => {
    const off = setup();
    expect(off.camera.evidence(0, 1000)).toBeNull();
    const { camera, frame } = await recordingSetup();
    camera.setRecordLandmarks(false);
    camera.syncRecording("recording");
    frame(100);
    expect(camera.getSnapshot().collecting).toBe(false);
    expect(camera.evidence(0, 1000)).toBeNull();
    camera.setRecordLandmarks(true);
    camera.syncRecording("saved");
    camera.syncRecording("recording");
    frame(200);
    expect(camera.evidence(500_000, 600_000)).toBeNull();
  });

  it("keeps what it collected after the stop (the bundle is built just after) and clears it on discard or the next start", async () => {
    const { camera, frame } = await recordingSetup();
    camera.syncRecording("recording");
    frame(100); frame(133);
    camera.syncRecording("saved");
    expect(camera.getSnapshot().collecting).toBe(false);
    expect(camera.evidence(0, 1000)).not.toBeNull();
    camera.syncRecording("recording");
    expect(camera.evidence(0, 1000)).toBeNull(); // a new recording starts empty (only its own pre-roll)
    camera.syncRecording("discarded");
    expect(camera.getSnapshot().collectedFrames).toBe(0);
  });

  it("stops keeping frames at the limit and says the recording was cut short", async () => {
    const { camera, frame } = await recordingSetup();
    camera.syncRecording("recording");
    for (let i = 0; i < MAX_RECORDED_FRAMES + 5; i += 1) frame(i * 10);
    expect(camera.getSnapshot().truncated).toBe(true);
    const evidence = camera.evidence(0, (MAX_RECORDED_FRAMES + 5) * 10)!;
    expect(evidence.source.configuration).toMatchObject({ frames: MAX_RECORDED_FRAMES, truncated: true });
  });
});
