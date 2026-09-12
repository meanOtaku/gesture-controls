import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppNav } from "./components/AppNav";
import { OperationFeedback } from "../components/app/OperationFeedback";
import { Skeleton } from "../components/ui/skeleton";
import { telemetryStore } from "../features/telemetry/store/telemetryStore";
import { usePendingActions } from "../shared/hooks/usePendingActions";
import { VolumeKnob } from "../features/overlay/components/VolumeKnob";
import {
  CALIBRATION_STATE_EVENT,
  HEAD_POSE_EVENT,
  HEAD_TARGET_ENTERED_EVENT,
  HEAD_TARGET_EXITED_EVENT,
  HEAD_TRACKER_CONNECTION_EVENT,
  OVERLAY_STATE_EVENT,
  SETTINGS_UPDATED_EVENT,
  WATCH_EDA_BATCH_EVENT,
  WATCH_HEART_RATE_BATCH_EVENT,
  WATCH_ORIENTATION_EVENT,
  WATCH_PPG_BATCH_EVENT,
  WATCH_SKIN_TEMPERATURE_BATCH_EVENT,
  WATCH_STATUS_EVENT,
  type AppSettings,
  type CalibrationState,
  type CalibrationTarget,
  type HeadPosePayload,

  type OverlayState,
  type WatchEdaBatch,
  type WatchHeartRateBatch,
  type WatchOrientationSample,
  type WatchPpgBatch,
  type WatchSkinTemperatureBatch,
  type WatchStatus,
} from "../shared/protocol/events";

const emptyOverlay: OverlayState = {
  visible: false,
  grabbed: false,
  volume: 50,
  rotationAngle: 0,
  screenX: 0,
  screenY: 0,
};

/**
 * Tab bodies are code-split by route: only the active tab's chunk loads. The
 * overlay window (`VolumeKnob`, above) is never part of this split — it is the
 * always-visible safety/control surface and must stay eagerly bundled.
 */
const Dashboard = lazy(() => import("../features/dashboard/components/Dashboard").then((m) => ({ default: m.Dashboard })));
const LiveTelemetry = lazy(() => import("../features/telemetry/components/LiveTelemetry").then((m) => ({ default: m.LiveTelemetry })));
const ModelLab = lazy(() => import("../features/model-lab/components/ModelLab").then((m) => ({ default: m.ModelLab })));
const Settings = lazy(() => import("../features/settings/components/Settings").then((m) => ({ default: m.Settings })));

function TabFallback() {
  return (
    <main className="shell" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="mt-3 h-48 w-full" />
      <Skeleton className="mt-3 h-48 w-full" />
    </main>
  );
}



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
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const status = telemetryStore.getHeadStatus();
  const watchStatus = telemetryStore.getWatchStatus();
  const [calibration, setCalibration] = useState<CalibrationState | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [volumeError, setVolumeError] = useState<string | null>(null);
  const [sensorControlError, setSensorControlError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<"main" | "headphone" | "watch" | "telemetry" | "modelLab" | "settings">("main");
  const { isPending, run } = usePendingActions();
  const calibrationEventVersion = useRef(0);
  const overlayEventVersion = useRef(0);
  const overlayVisible = useRef(false);
  const overlayDesiredVisible = useRef<boolean | null>(null);
  const volumeAdjustmentInFlight = useRef(false);
  const volumeRequestVersion = useRef(0);
  const settingsWriteChain = useRef<Promise<void>>(Promise.resolve());
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
        if (!cancelled) telemetryStore.ingestHeadPose(payload);
      }),
      listen<boolean>(HEAD_TRACKER_CONNECTION_EVENT, ({ payload }) => {
        if (cancelled) return;
        telemetryStore.setHeadConnected(payload);
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
      if (event.key === "Escape") {
        hideOverlay();
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement
        && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))) return;
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
      if (!cancelled) telemetryStore.ingestWatchStatus(payload);
    });
    const orientationRegistration = listen<WatchOrientationSample>(WATCH_ORIENTATION_EVENT, ({ payload }) => {
      if (!cancelled) telemetryStore.ingestWatchOrientation(payload);
    });
    const ppgRegistration = listen<WatchPpgBatch>(WATCH_PPG_BATCH_EVENT, ({ payload }) => {
      if (!cancelled) telemetryStore.ingestPpgBatch(payload);
    });
    const heartRateRegistration = listen<WatchHeartRateBatch>(WATCH_HEART_RATE_BATCH_EVENT, ({ payload }) => {
      if (!cancelled) telemetryStore.ingestHeartRateBatch(payload);
    });
    const skinTemperatureRegistration = listen<WatchSkinTemperatureBatch>(WATCH_SKIN_TEMPERATURE_BATCH_EVENT, ({ payload }) => {
      if (!cancelled) telemetryStore.ingestSkinTemperatureBatch(payload);
    });
    const edaRegistration = listen<WatchEdaBatch>(WATCH_EDA_BATCH_EVENT, ({ payload }) => {
      if (!cancelled) telemetryStore.ingestEdaBatch(payload);
    });
    void registration.then(() =>
      invoke<WatchStatus>("get_watch_status").then((state) => {
        if (!cancelled) telemetryStore.ingestWatchStatus(state);
      })
    ).catch(() => undefined);

    return () => {
      cancelled = true;
      void registration.then((unlisten) => unlisten());
      void orientationRegistration.then((unlisten) => unlisten());
      void ppgRegistration.then((unlisten) => unlisten());
      void heartRateRegistration.then((unlisten) => unlisten());
      void skinTemperatureRegistration.then((unlisten) => unlisten());
      void edaRegistration.then((unlisten) => unlisten());
    };
  }, [inTauri]);

  const applyLiveSettings = (next: AppSettings) => {
    telemetryStore.setGraphRefreshRateHz(next.graphRefreshRateHz);
    telemetryStore.setRecordingRateHz(next.recordingRateHz);
    telemetryStore.setHealthAcceptanceRatesHz({
      heartRate: next.watchHeartRateAcceptanceRateHz,
      temperature: next.watchSkinTemperatureAcceptanceRateHz,
      eda: next.watchEdaAcceptanceRateHz,
    });
    setSettings(next);
  };

  const queueSettingsWrite = (write: () => Promise<AppSettings>) => {
    const outcome = settingsWriteChain.current
      .catch(() => undefined)
      .then(async () => {
        setSettingsError(null);
        applyLiveSettings(await write());
      });
    settingsWriteChain.current = outcome.catch(() => undefined);
    return outcome;
  };

  const updateSettings = (next: AppSettings) => {
    if (!inTauri) return;
    void run("settings:apply", async () => {
      try {
        await queueSettingsWrite(() => invoke<AppSettings>("update_settings", { settings: next }));
        OperationFeedback.success("Apply settings", "Rates updated.");
      } catch (error) {
        setSettingsError(String(error));
        OperationFeedback.error("Apply settings", String(error));
      }
    });
  };

  const resetSettings = () => {
    if (!inTauri) return;
    void run("settings:reset", async () => {
      try {
        await queueSettingsWrite(() => invoke<AppSettings>("reset_settings"));
        OperationFeedback.success("Reset settings", "Restored defaults.");
      } catch (error) {
        setSettingsError(String(error));
        OperationFeedback.error("Reset settings", String(error));
      }
    });
  };

  useEffect(() => {
    if (!inTauri) return;

    let cancelled = false;
    const registration = listen<AppSettings>(SETTINGS_UPDATED_EVENT, ({ payload }) => {
      if (!cancelled) applyLiveSettings(payload);
    });
    void registration.then(() =>
      invoke<AppSettings>("get_settings").then((state) => {
        if (!cancelled) applyLiveSettings(state);
      })
    ).catch((error) => {
      if (!cancelled) setSettingsError(String(error));
    });

    return () => {
      cancelled = true;
      void registration.then((unlisten) => unlisten());
    };
  }, [inTauri]);

  const captureTarget = async (target: CalibrationTarget) => {
    if (!inTauri) return;
    await run(`capture:${target}`, async () => {
      try {
        setCalibrationError(null);
        await invoke<CalibrationState>("capture_calibration_target", { target });
        OperationFeedback.success(
          "Capture calibration target",
          target === "center" ? "Center position saved." : "Top-right position saved.",
        );
      } catch (error) {
        setCalibrationError(String(error));
        OperationFeedback.error("Capture calibration target", String(error));
      }
    });
  };

  const updateCalibration = async (activationThresholdDegrees: number, dwellMs: number) => {
    if (!inTauri) return;
    await run("calibration:update", async () => {
      try {
        setCalibrationError(null);
        await invoke<CalibrationState>("update_calibration_config", {
          activationThresholdDegrees,
          dwellMs,
        });
        OperationFeedback.success("Update calibration", "Threshold and dwell saved.");
      } catch (error) {
        setCalibrationError(String(error));
        OperationFeedback.error("Update calibration", String(error));
      }
    });
  };

  const setSensorEnabled = async (sensor: string, enabled: boolean) => {
    if (!inTauri) return;
    await run(`sensor:${sensor}`, async () => {
      try {
        setSensorControlError(null);
        await invoke("set_sensor_enabled", { sensor, enabled });
        OperationFeedback.success("Sensor control", `${sensor.replaceAll("_", " ")} ${enabled ? "enabled" : "disabled"}.`);
      } catch (error) {
        setSensorControlError(String(error));
        OperationFeedback.error("Sensor control", String(error));
      }
    });
  };

  const applicationError = [calibrationError, volumeError, sensorControlError]
    .filter((error): error is string => error !== null)
    .join(" · ") || null;

  return <>
    <AppNav activeTab={activeTab} onSelect={setActiveTab} />
    <Suspense fallback={<TabFallback />}>
    {activeTab === "main" && (
      <Dashboard
        onNavigate={setActiveTab}
        view="main"
        status={status}
        calibration={calibration}
        calibrationError={applicationError}
        watchStatus={watchStatus}
        isPending={isPending}
        onCaptureTarget={(target) => { void captureTarget(target); }}
        onUpdateCalibration={(threshold, dwell) => { void updateCalibration(threshold, dwell); }}
      />
    )}
    {activeTab === "headphone" && (
      <Dashboard
        view="headphone"
        status={status}
        calibration={calibration}
        calibrationError={applicationError}
        watchStatus={watchStatus}
        isPending={isPending}
        onCaptureTarget={(target) => { void captureTarget(target); }}
        onUpdateCalibration={(threshold, dwell) => { void updateCalibration(threshold, dwell); }}
      />
    )}
    {activeTab === "watch" && (
      <Dashboard
        view="watch"
        status={status}
        calibration={calibration}
        calibrationError={applicationError}
        watchStatus={watchStatus}
        isPending={isPending}
        onCaptureTarget={(target) => { void captureTarget(target); }}
        onUpdateCalibration={(threshold, dwell) => { void updateCalibration(threshold, dwell); }}
        onSetSensorEnabled={(sensor, enabled) => { void setSensorEnabled(sensor, enabled); }}
      />
    )}
    {activeTab === "telemetry" && (
      <LiveTelemetry />
    )}
    {activeTab === "modelLab" && (
      <ModelLab />
    )}
    {activeTab === "settings" && (
      <Settings
        settings={settings}
        error={settingsError}
        isPending={isPending}
        onUpdate={(next) => { void updateSettings(next); }}
        onReset={() => { void resetSettings(); }}
      />
    )}
    </Suspense>
  </>;
}
