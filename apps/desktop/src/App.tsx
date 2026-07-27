import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { Dashboard } from "./components/Dashboard";
import {
  CALIBRATION_STATE_EVENT,
  HEAD_POSE_EVENT,
  HEAD_TARGET_ENTERED_EVENT,
  HEAD_TARGET_EXITED_EVENT,
  HEAD_TRACKER_CONNECTION_EVENT,
  type CalibrationState,
  type CalibrationTarget,
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
  const [calibration, setCalibration] = useState<CalibrationState | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const calibrationEventVersion = useRef(0);
  const inTauri = "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    if (!inTauri) return;

    const listenerRegistrations = [
      listen<HeadPosePayload>(HEAD_POSE_EVENT, ({ payload }) =>
        setStatus({ ...payload, connected: true })),
      listen<boolean>(HEAD_TRACKER_CONNECTION_EVENT, ({ payload }) =>
        setStatus((current) => ({ ...(current ?? emptyStatus), connected: payload }))),
      listen<CalibrationState>(CALIBRATION_STATE_EVENT, ({ payload }) => {
        calibrationEventVersion.current += 1;
        setCalibration(payload);
      }),
      listen<CalibrationTarget>(HEAD_TARGET_ENTERED_EVENT, ({ payload }) => {
        calibrationEventVersion.current += 1;
        setCalibration((current) => current ? { ...current, activeTarget: payload } : current);
      }),
      listen<CalibrationTarget>(HEAD_TARGET_EXITED_EVENT, ({ payload }) => {
        calibrationEventVersion.current += 1;
        setCalibration((current) =>
          current?.activeTarget === payload ? { ...current, activeTarget: null } : current);
      }),
    ];
    const unlisteners = Promise.allSettled(listenerRegistrations).then((results) => {
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        setCalibrationError(`Failed to subscribe to ${failures.length} application event(s)`);
      }
      const requestedVersion = calibrationEventVersion.current;
      void invoke<CalibrationState>("get_calibration_state")
        .then((state) => {
          if (calibrationEventVersion.current === requestedVersion) setCalibration(state);
        })
        .catch((error) => setCalibrationError(String(error)));
      return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    });
    return () => { void unlisteners.then((items) => items.forEach((unlisten) => unlisten())); };
  }, [inTauri]);

  const captureTarget = async (target: CalibrationTarget) => {
    if (!inTauri) return;
    try {
      setCalibrationError(null);
      await invoke<CalibrationState>("capture_calibration_target", { target });
    } catch (error) {
      setCalibrationError(String(error));
    }
  };

  const updateCalibration = async (activationThresholdDegrees: number, dwellMs: number) => {
    if (!inTauri) return;
    try {
      setCalibrationError(null);
      await invoke<CalibrationState>("update_calibration_config", {
        activationThresholdDegrees,
        dwellMs,
      });
    } catch (error) {
      setCalibrationError(String(error));
    }
  };

  return (
    <Dashboard
      status={status}
      calibration={calibration}
      calibrationError={calibrationError}
      onCaptureTarget={(target) => { void captureTarget(target); }}
      onUpdateCalibration={(threshold, dwell) => { void updateCalibration(threshold, dwell); }}
    />
  );
}
