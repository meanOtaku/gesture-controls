import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Dashboard } from "./components/Dashboard";
import {
  HEAD_POSE_EVENT,
  HEAD_TRACKER_CONNECTION_EVENT,
  HEAD_TRACKER_STATUS_EVENT,
  newestRuntimeStatus,
  type HeadPosePayload,
  type HeadTrackerRuntimeStatus,
  type HeadTrackerStatus,
} from "./protocol/events";

const emptyStatus: HeadTrackerStatus = {
  connected: false,
  timestampNs: 0,
  device: null,
  quaternion: [1, 0, 0, 0],
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  gyroscope: null,
  angularVelocity: null,
  accelerometer: null,
  packetsPerSecond: 0,
  receiveLatencyMs: -1,
  resetCounter: 0,
};

const initialRuntime: HeadTrackerRuntimeStatus = {
  state: "starting",
  message: "Starting built-in Sony tracker",
  device: null,
  revision: 0,
  canRecenter: true,
};

export default function App() {
  const [status, setStatus] = useState<HeadTrackerStatus | null>(null);
  const [runtime, setRuntime] = useState<HeadTrackerRuntimeStatus>(initialRuntime);
  const inTauri = "__TAURI_INTERNALS__" in window;

  const applyRuntimeStatus = (incoming: HeadTrackerRuntimeStatus) => {
    setRuntime((current) => newestRuntimeStatus(current, incoming));
  };

  useEffect(() => {
    if (!inTauri) {
      setRuntime({ state: "unsupported", message: "Desktop runtime is unavailable in browser preview", device: null, revision: 0, canRecenter: false });
      return;
    }
    const unlisteners = Promise.all([
      listen<HeadPosePayload>(HEAD_POSE_EVENT, ({ payload }) => setStatus({ ...payload, connected: true })),
      listen<boolean>(HEAD_TRACKER_CONNECTION_EVENT, ({ payload }) =>
        setStatus((current) => ({ ...(current ?? emptyStatus), connected: payload }))),
      listen<HeadTrackerRuntimeStatus>(HEAD_TRACKER_STATUS_EVENT, ({ payload }) => applyRuntimeStatus(payload)),
    ]);
    void unlisteners
      .then(() => invoke<HeadTrackerRuntimeStatus>("get_head_tracker_status"))
      .then(applyRuntimeStatus)
      .catch((error: unknown) => setRuntime((current) => ({ ...current, state: "error", message: String(error) })));
    return () => { void unlisteners.then((items) => items.forEach((unlisten) => unlisten())); };
  }, [inTauri]);

  const recenter = () => {
    if (!inTauri || !runtime.canRecenter) return;
    void invoke("recenter_head_tracker").catch((error: unknown) =>
      setRuntime((current) => ({ ...current, state: "error", message: String(error) })));
  };

  return <Dashboard status={status} runtime={runtime} onRecenter={recenter} />;
}
