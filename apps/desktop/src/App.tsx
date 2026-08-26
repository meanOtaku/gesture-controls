import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { Dashboard } from "./components/Dashboard";
import { LiveTelemetry } from "./components/LiveTelemetry";
import { VolumeKnob } from "./components/VolumeKnob";
import {
  CALIBRATION_STATE_EVENT,
  HEAD_POSE_EVENT,
  HEAD_TARGET_ENTERED_EVENT,
  HEAD_TARGET_EXITED_EVENT,
  HEAD_TRACKER_CONNECTION_EVENT,
  OVERLAY_STATE_EVENT,
  WATCH_PPG_BATCH_EVENT,
  WATCH_STATUS_EVENT,
  type CalibrationState,
  type CalibrationTarget,
  type HeadPosePayload,
  type HeadTrackerStatus,
  type OverlayState,
  type WatchPpgBatch,
  type WatchStatus,
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

const emptyWatchStatus: WatchStatus = {
  connected: false,
  lastOrientation: null,
  lastHeartbeat: null,
  clockOffsetNs: null,
  roundTripNs: null,
  ppgState: null,
  ppgLastSample: null,
  ppgRateHz: null,
  lastButtonState: null,
  medicalStatus: {},
  sensorStatus: {},
  heartRateLast: null,
  heartRateRateHz: null,
  skinTemperatureLast: null,
  skinTemperatureRateHz: null,
  edaLast: null,
  edaRateHz: null,
  spo2Last: null,
  ecgLast: null,
  biaLast: null,
  sweatLossLast: null,
};

export default function App() {
  const overlayWindow = new URLSearchParams(window.location.search).get("window") === "overlay";
  return overlayWindow ? <OverlayApp /> : <MainApp />;
}

function OverlayApp() {
  const [overlay, setOverlay] = useState<OverlayState>(emptyOverlay);
  const volumeRefreshInFlight = useRef(false);
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

  useEffect(() => {
    if (!inTauri || !overlay.visible) return;

    let cancelled = false;
    const refresh = () => {
      if (cancelled || volumeRefreshInFlight.current) return;
      volumeRefreshInFlight.current = true;
      void invoke("refresh_system_volume")
        .catch(() => undefined)
        .finally(() => { volumeRefreshInFlight.current = false; });
    };
    refresh();
    const interval = window.setInterval(refresh, 400);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [inTauri, overlay.visible]);

  return <main className="overlay-shell"><VolumeKnob volume={overlay.volume} grabbed={overlay.grabbed} /></main>;
}

function MainApp() {
  const [status, setStatus] = useState<HeadTrackerStatus | null>(null);
  const [calibration, setCalibration] = useState<CalibrationState | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [volumeError, setVolumeError] = useState<string | null>(null);
  const [sensorControlError, setSensorControlError] = useState<string | null>(null);
  const [watchStatus, setWatchStatus] = useState<WatchStatus>(emptyWatchStatus);
  const [ppgBatch, setPpgBatch] = useState<WatchPpgBatch | null>(null);
  const [activeTab, setActiveTab] = useState<"main" | "headphone" | "watch" | "telemetry">("main");
  const calibrationEventVersion = useRef(0);
  const overlayEventVersion = useRef(0);
  const overlayVisible = useRef(false);
  const overlayDesiredVisible = useRef<boolean | null>(null);
  const volumeAdjustmentInFlight = useRef(false);
  const volumeRequestVersion = useRef(0);
  const inTauri = "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    if (!inTauri) return;

    let cancelled = false;
    const hideOverlay = () => {
      if (cancelled) return;
      overlayDesiredVisible.current = false;
      overlayVisible.current = false;
      const requestVersion = ++volumeRequestVersion.current;
      void invoke("hide_overlay")
        .then(() => {
          if (!cancelled && volumeRequestVersion.current === requestVersion) setVolumeError(null);
        })
        .catch((error) => {
          if (!cancelled && volumeRequestVersion.current === requestVersion) {
            setVolumeError(`Volume overlay failed to hide: ${String(error)}`);
          }
        });
    };
    const showOverlay = () => {
      if (cancelled) return;
      overlayDesiredVisible.current = true;
      const requestVersion = ++volumeRequestVersion.current;
      void invoke("show_overlay")
        .then(() => {
          if (!cancelled && volumeRequestVersion.current === requestVersion) setVolumeError(null);
        })
        .catch((error) => {
          if (!cancelled && volumeRequestVersion.current === requestVersion) {
            overlayDesiredVisible.current = false;
            overlayVisible.current = false;
            setVolumeError(`Volume control failed: ${String(error)}`);
          }
        });
    };
    const listenerRegistrations = [
      listen<OverlayState>(OVERLAY_STATE_EVENT, ({ payload }) => {
        if (cancelled) return;
        overlayEventVersion.current += 1;
        if (payload.visible && overlayDesiredVisible.current === false) return;
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
        if (payload === "topRight") showOverlay();
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
          if (!cancelled
            && overlayEventVersion.current === requestedOverlayVersion
            && !(state.visible && overlayDesiredVisible.current === false)) {
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
            if (state.activeTarget === "topRight") showOverlay();
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
        if (volumeAdjustmentInFlight.current) return;
        volumeAdjustmentInFlight.current = true;
        const requestVersion = ++volumeRequestVersion.current;
        void invoke("adjust_system_volume", { delta })
          .then(() => {
            if (!cancelled && volumeRequestVersion.current === requestVersion) setVolumeError(null);
          })
          .catch((error) => {
            if (!cancelled && volumeRequestVersion.current === requestVersion) {
              setVolumeError(`Volume control failed: ${String(error)}`);
            }
          })
          .finally(() => { volumeAdjustmentInFlight.current = false; });
      } else if (event.key === "Escape") {
        hideOverlay();
      }
    };
    window.addEventListener("keydown", handleKeyboard);

    return () => {
      cancelled = true;
      volumeRequestVersion.current += 1;
      overlayDesiredVisible.current = false;
      overlayVisible.current = false;
      window.removeEventListener("keydown", handleKeyboard);
      void unlisteners.then((items) => items.forEach((unlisten) => unlisten()));
    };
  }, [inTauri]);

  useEffect(() => {
    if (!inTauri) return;

    let cancelled = false;
    const registration = listen<WatchStatus>(WATCH_STATUS_EVENT, ({ payload }) => {
      if (!cancelled) setWatchStatus(payload);
    });
    const ppgRegistration = listen<WatchPpgBatch>(WATCH_PPG_BATCH_EVENT, ({ payload }) => {
      if (!cancelled) setPpgBatch(payload);
    });
    void registration.then(() =>
      invoke<WatchStatus>("get_watch_status").then((state) => {
        if (!cancelled) setWatchStatus(state);
      })
    ).catch(() => undefined);

    return () => {
      cancelled = true;
      void registration.then((unlisten) => unlisten());
      void ppgRegistration.then((unlisten) => unlisten());
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

  const setSensorEnabled = async (sensor: string, enabled: boolean) => {
    if (!inTauri) return;
    try {
      setSensorControlError(null);
      await invoke("set_sensor_enabled", { sensor, enabled });
    } catch (error) {
      setSensorControlError(String(error));
    }
  };

  const applicationError = [calibrationError, volumeError, sensorControlError]
    .filter((error): error is string => error !== null)
    .join(" · ") || null;

  return <>
    <nav className="app-tabs" aria-label="Application views">
      <button className={activeTab === "main" ? "active" : ""} onClick={() => setActiveTab("main")}>Main</button>
      <button className={activeTab === "headphone" ? "active" : ""} onClick={() => setActiveTab("headphone")}>Headphones</button>
      <button className={activeTab === "watch" ? "active" : ""} onClick={() => setActiveTab("watch")}>Watch</button>
      <button className={activeTab === "telemetry" ? "active" : ""} onClick={() => setActiveTab("telemetry")}>Live data</button>
    </nav>
    {activeTab === "main" && (
      <Dashboard
        view="main"
        status={status}
        calibration={calibration}
        calibrationError={applicationError}
        watchStatus={watchStatus}
        onCaptureTarget={(target) => { void captureTarget(target); }}
        onUpdateCalibration={(threshold, dwell) => { void updateCalibration(threshold, dwell); }}
      />
    )}
    {activeTab === "headphone" && (
      <Dashboard view="headphone" status={status} calibration={calibration} calibrationError={applicationError} watchStatus={watchStatus} onCaptureTarget={(target) => { void captureTarget(target); }} onUpdateCalibration={(threshold, dwell) => { void updateCalibration(threshold, dwell); }} />
    )}
    {activeTab === "watch" && (
      <Dashboard view="watch" status={status} calibration={calibration} calibrationError={applicationError} watchStatus={watchStatus} onCaptureTarget={(target) => { void captureTarget(target); }} onUpdateCalibration={(threshold, dwell) => { void updateCalibration(threshold, dwell); }} onSetSensorEnabled={(sensor, enabled) => { void setSensorEnabled(sensor, enabled); }} />
    )}
    {activeTab === "telemetry" && (
      <LiveTelemetry status={status} watchStatus={watchStatus} ppgBatch={ppgBatch} />
    )}
  </>;
}
