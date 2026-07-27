import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Dashboard } from "./components/Dashboard";
import {
  HEAD_POSE_EVENT,
  HEAD_TRACKER_CONNECTION_EVENT,
  type HeadPosePayload,
  type HeadTrackerStatus,
} from "./protocol/events";

const emptyStatus: HeadTrackerStatus = {
  connected: false,
  device: null,
  quaternion: [1, 0, 0, 0],
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  gyroscope: null,
  packetsPerSecond: 0,
  receiveLatencyMs: -1,
  resetCounter: 0,
};

export default function App() {
  const [status, setStatus] = useState<HeadTrackerStatus | null>(null);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }
    const unlisteners = Promise.all([
      listen<HeadPosePayload>(HEAD_POSE_EVENT, ({ payload }) => setStatus({ ...payload, connected: true })),
      listen<boolean>(HEAD_TRACKER_CONNECTION_EVENT, ({ payload }) =>
        setStatus((current) => ({ ...(current ?? emptyStatus), connected: payload }))),
    ]);
    return () => { void unlisteners.then((items) => items.forEach((unlisten) => unlisten())); };
  }, []);

  return <Dashboard status={status} />;
}
