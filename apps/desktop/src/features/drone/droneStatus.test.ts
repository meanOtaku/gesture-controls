import { afterEach, describe, expect, it } from "vitest";
import { droneDevice, getDroneSnapshot, publishDroneState, type DroneState, type DroneStatus } from "./droneStatus";

const state: DroneState = {
  phase: "open",
  armed: false,
  failsafeTripped: false,
  steering: false,
  watchStreaming: false,
  framesSent: 0,
  videoFrames: 0,
  videoSkipped: 0,
  videoDamaged: 0,
  sendErrors: 0,
  flow: null,
  driftX: 0,
  driftY: 0,
  holding: false,
  correction: null,
  pageAlive: false,
};

const status = (over: Partial<DroneStatus>): DroneStatus => ({ ...state, videoRate: null, ...over });

afterEach(() => publishDroneState(null));

describe("droneDevice", () => {
  it("is offline with no link", () => {
    expect(droneDevice(null)).toEqual({ tone: "offline", text: "OFFLINE" });
    expect(droneDevice(status({ phase: "disconnected" })).tone).toBe("offline");
    expect(droneDevice(status({ phase: "closed" })).tone).toBe("offline");
  });

  it("is live when connected", () => {
    expect(droneDevice(status({}))).toEqual({ tone: "active", text: "ONLINE" });
    expect(droneDevice(status({ phase: "opening" }))).toEqual({ tone: "unknown", text: "CONNECTING" });
  });

  it("warns whenever the drone could move or something went wrong", () => {
    expect(droneDevice(status({ armed: true }))).toEqual({ tone: "caution", text: "ARMED" });
    expect(droneDevice(status({ armed: true, holding: true }))).toEqual({ tone: "caution", text: "HOLDING" });
    expect(droneDevice(status({ failsafeTripped: true }))).toEqual({ tone: "caution", text: "FAILSAFE" });
    expect(droneDevice(status({ phase: "failed" }))).toEqual({ tone: "caution", text: "NO ANSWER" });
  });
});

describe("publishDroneState", () => {
  it("works out the frame rate once a second has passed", () => {
    publishDroneState({ ...state, videoFrames: 100 }, 0);
    expect(getDroneSnapshot()?.videoRate).toBeNull();
    publishDroneState({ ...state, videoFrames: 108 }, 500);
    expect(getDroneSnapshot()?.videoRate).toBeNull();
    publishDroneState({ ...state, videoFrames: 116 }, 1000);
    expect(getDroneSnapshot()?.videoRate).toBe(16);
  });

  it("starts the rate again after a new connection resets the count", () => {
    publishDroneState({ ...state, videoFrames: 500 }, 0);
    publishDroneState({ ...state, videoFrames: 516 }, 1000);
    publishDroneState({ ...state, videoFrames: 3 }, 1500);
    expect(getDroneSnapshot()?.videoRate).toBeNull();
  });

  it("forgets everything when the app cannot read the drone", () => {
    publishDroneState(state, 0);
    publishDroneState(null);
    expect(getDroneSnapshot()).toBeNull();
  });
});
