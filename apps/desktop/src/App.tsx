import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { Dashboard } from "./components/Dashboard";
import { VolumeKnob } from "./components/VolumeKnob";
import {
  CALIBRATION_STATE_EVENT,
  HEAD_POSE_EVENT,
  HEAD_TARGET_ENTERED_EVENT,
  HEAD_TARGET_EXITED_EVENT,
  HEAD_TRACKER_CONNECTION_EVENT,
  OVERLAY_STATE_EVENT,
  type CalibrationState,
  type CalibrationTarget,
  type HeadPosePayload,
  type HeadTrackerStatus,
  type OverlayState,
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

const emptyOverlay: OverlayState = {
  visible: false,
  grabbed: false,
  volume: 50,
  rotationAngle: 0,
  screenX: 0,
  screenY: 0,
};

export default function App() {
  const overlayWindow = new URLSearchParams(window.location.search).get("window") === "overlay";
  return overlayWindow ? <OverlayApp /> : <MainApp />;
}

function OverlayApp() {
  const [overlay, setOverlay] = useState<OverlayState>(emptyOverlay);
  const inTauri = "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    document.documentElement.classList.add("overlay-document");
    if (!inTauri) return () => document.documentElement.classList.remove("overlay-document");

    let generation = 0;
    let cancelled = false;
    const registration = listen<OverlayState>(OVERLAY_STATE_EVENT, ({ payload }) => {
      generation += 1;
      if (!cancelled) setOverlay(payload);
    });
    void registration.then(() => {
      const requestedGeneration = generation;
      return invoke<OverlayState>("get_overlay_state")
        .then((state) => {
          if (!cancelled && generation === requestedGeneration) setOverlay(state);
        });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      document.documentElement.classList.remove("overlay-document");
      void registration.then((unlisten) => unlisten());
    };
  }, [inTauri]);

  return <main className="overlay-shell"><VolumeKnob volume={overlay.volume} /></main>;
}

function MainApp() {
  const [status, setStatus] = useState<HeadTrackerStatus | null>(null);
  const [calibration, setCalibration] = useState<CalibrationState | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const calibrationEventVersion = useRef(0);
  const overlayEventVersion = useRef(0);
  const overlayVisible = useRef(false);
  const inTauri = "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    if (!inTauri) return;

    let cancelled = false;
    const hideOverlay = () => { if (!cancelled) void invoke("hide_overlay"); };
    const listenerRegistrations = [
      listen<OverlayState>(OVERLAY_STATE_EVENT, ({ payload }) => {
        if (cancelled) return;
        overlayEventVersion.current += 1;
        overlayVisible.current = payload.visible;
      }),
      listen<HeadPosePayload>(HEAD_POSE_EVENT, ({ payload }) => {
        if (!cancelled) setStatus({ ...payload, connected: true });
      }),
      listen<boolean>(HEAD_TRACKER_CONNECTION_EVENT, ({ payload }) => {
        if (cancelled) return;
        setStatus((current) => ({ ...(current ?? emptyStatus), connected: payload }));
        if (!payload) hideOverlay();
      }),
      listen<CalibrationState>(CALIBRATION_STATE_EVENT, ({ payload }) => {
        if (cancelled) return;
        calibrationEventVersion.current += 1;
        setCalibration(payload);
      }),
      listen<CalibrationTarget>(HEAD_TARGET_ENTERED_EVENT, ({ payload }) => {
        if (cancelled) return;
        calibrationEventVersion.current += 1;
        setCalibration((current) => current ? { ...current, activeTarget: payload } : current);
        if (payload === "topRight") void invoke("show_overlay");
      }),
      listen<CalibrationTarget>(HEAD_TARGET_EXITED_EVENT, ({ payload }) => {
        if (cancelled) return;
        calibrationEventVersion.current += 1;
        setCalibration((current) =>
          current?.activeTarget === payload ? { ...current, activeTarget: null } : current);
        if (payload === "topRight") hideOverlay();
      }),
    ];
    const unlisteners = Promise.allSettled(listenerRegistrations).then((results) => {
      const failures = results.filter((result) => result.status === "rejected");
      if (!cancelled && failures.length > 0) {
        setCalibrationError(`Failed to subscribe to ${failures.length} application event(s)`);
      }
      const requestedOverlayVersion = overlayEventVersion.current;
      void invoke<OverlayState>("get_overlay_state")
        .then((state) => {
          if (!cancelled && overlayEventVersion.current === requestedOverlayVersion) {
            overlayVisible.current = state.visible;
          }
        })
        .catch((error) => {
          if (!cancelled) setCalibrationError(String(error));
        });
      const requestedVersion = calibrationEventVersion.current;
      void invoke<CalibrationState>("get_calibration_state")
        .then((state) => {
          if (!cancelled && calibrationEventVersion.current === requestedVersion) {
            setCalibration(state);
            if (state.activeTarget === "topRight") void invoke("show_overlay");
          }
        })
        .catch((error) => {
          if (!cancelled) setCalibrationError(String(error));
        });
      return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    });

    const handleKeyboard = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement
        && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const delta = event.key === "ArrowUp" || event.key === "ArrowRight" || event.key === "+" ? 5
        : event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "-" ? -5
          : null;
      if (delta !== null && overlayVisible.current) {
        event.preventDefault();
        void invoke("adjust_simulated_volume", { delta });
      } else if (event.key === "Escape") {
        hideOverlay();
      }
    };
    window.addEventListener("keydown", handleKeyboard);

    return () => {
      cancelled = true;
      overlayVisible.current = false;
      window.removeEventListener("keydown", handleKeyboard);
      void unlisteners.then((items) => items.forEach((unlisten) => unlisten()));
    };
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
