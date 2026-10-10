import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DeviceKind } from "../features/recipes/recipeModel";
import { AppNav, navStatuses, type AppTab } from "./components/AppNav";
import { OperationFeedback } from "../components/app/OperationFeedback";
import { Skeleton } from "../components/ui/skeleton";
import { SidebarInset, SidebarProvider } from "../components/ui/sidebar";
import { CameraGestureBridge } from "../features/gestureLibrary/CameraGestureBridge";
import { bindCameraToRecording, watchCameraDevices } from "../features/camera/cameraService";
import { RecordingTimer } from "../features/telemetry/recording/RecordingTimer";
import { telemetryStore } from "../features/telemetry/store/telemetryStore";
import { usePendingActions } from "../shared/hooks/usePendingActions";
import { useStableCallback } from "../shared/hooks/useStableCallback";
import { VolumeKnob } from "../features/overlay/components/VolumeKnob";
import {
  ACTION_ERROR_EVENT,
  PITCH_DETECTED_EVENT,
  ROLL_DETECTED_EVENT,
  SHAKE_DETECTED_EVENT,
  SWIPE_DETECTED_EVENT,
  TAP_DETECTED_EVENT,
  AUTOMATION_STATE_EVENT,
  CALIBRATION_STATE_EVENT,
  HEAD_POSE_EVENT,
  HEAD_TARGET_ENTERED_EVENT,
  HEAD_TARGET_EXITED_EVENT,
  HEAD_TRACKER_CONNECTION_EVENT,
  HEAD_TRACKER_DIAGNOSTIC_EVENT,
  OVERLAY_STATE_EVENT,
  SETTINGS_UPDATED_EVENT,
  WATCH_EDA_BATCH_EVENT,
  WATCH_HEART_RATE_BATCH_EVENT,
  WATCH_ORIENTATION_EVENT,
  WATCH_PPG_BATCH_EVENT,
  WATCH_SKIN_TEMPERATURE_BATCH_EVENT,
  WATCH_STATUS_EVENT,
  type AppSettings,
  type ActionError,
  type PitchDirection,
  type RollDirection,
  type SwipeDirection,
  type TapKind,
  type AutomationState,
  type Recipe,
  type CalibrationState,
  type CalibrationTarget,
  type HeadPosePayload,
  type HeadTrackerDiagnostic,
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
  lastNativeVolumeError: null,
};

/**
 * Tab bodies are code-split by route: only the active tab's chunk loads. The
 * overlay window (`VolumeKnob`, above) is never part of this split — it is the
 * always-visible safety/control surface and must stay eagerly bundled.
 */
const Dashboard = lazy(() => import("../features/dashboard/components/Dashboard").then((m) => ({ default: m.Dashboard })));
// Recipes, Gestures and Virtual devices are memoised the same way, so everything passed to them must keep its identity
// between publishes (state, or `useStableCallback`), or the memo does nothing.
// `MainApp` re-renders on every telemetry publish (~15 Hz while a watch streams). These two
// tabs take no props, so `memo` lets React skip them when only the parent changed;
// The capture pages still update themselves through their own store subscription, and Model Lab shows
// nothing that the telemetry store drives. Without it the whole Model Lab tree (datasets,
// registry, lifecycle controls) re-rendered 15 times a second while merely open.
const LiveSignalsPage = memo(lazy(() => import("../features/telemetry/components/LiveSignalsPage").then((m) => ({ default: m.LiveSignalsPage }))));
const RecorderPage = memo(lazy(() => import("../features/telemetry/components/RecorderPage").then((m) => ({ default: m.RecorderPage }))));
const RecordingsPage = memo(lazy(() => import("../features/telemetry/components/RecordingsPage").then((m) => ({ default: m.RecordingsPage }))));
const ModelLab = memo(lazy(() => import("../features/model-lab/components/ModelLab").then((m) => ({ default: m.ModelLab }))));
const RecipesPage = memo(lazy(() => import("../features/recipes/components/RecipesPage").then((m) => ({ default: m.RecipesPage }))));
const GesturesPage = memo(lazy(() => import("../features/gestures/components/GesturesPage").then((m) => ({ default: m.GesturesPage }))));
const VirtualDevicesPage = memo(lazy(() => import("../features/devices/components/VirtualDevicesPage").then((m) => ({ default: m.VirtualDevicesPage }))));
const LabelsPage = memo(lazy(() => import("../features/labels/LabelsPage").then((m) => ({ default: m.LabelsPage }))));
const GestureLibraryPage = memo(lazy(() => import("../features/gestureLibrary/GestureLibraryPage").then((m) => ({ default: m.GestureLibraryPage }))));
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

  return (
    <main className="overlay-shell">
      <VolumeKnob
        volume={overlay.volume}
        grabbed={overlay.grabbed}
        nativeVolumeError={overlay.lastNativeVolumeError}
      />
    </main>
  );
}

function MainApp() {
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const status = telemetryStore.getHeadStatus();
  const headDiagnostic = telemetryStore.getHeadDiagnostic();
  const headTrackerProvider = telemetryStore.getHeadTrackerProvider();
  const watchStatus = telemetryStore.getWatchStatus();
  const [calibration, setCalibration] = useState<CalibrationState | null>(null);
  const [shakeDetections, setShakeDetections] = useState(0);
  const [lastPitch, setLastPitch] = useState<{ direction: PitchDirection; count: number } | null>(null);
  const [lastRoll, setLastRoll] = useState<{ direction: RollDirection; count: number } | null>(null);
  const [lastTap, setLastTap] = useState<{ kind: TapKind; count: number } | null>(null);
  const [lastSwipe, setLastSwipe] = useState<{ direction: SwipeDirection; count: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [automation, setAutomation] = useState<AutomationState | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OverlayState>(emptyOverlay);
  const [volumeError, setVolumeError] = useState<string | null>(null);
  const [sensorControlError, setSensorControlError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<AppTab>("main");
  const [startWithDevice, setStartWithDevice] = useState<DeviceKind | null>(null);
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
        })
        .finally(() => {
          // The hide is settled, so a later overlay shown by a recipe is no longer a stale event to ignore.
          if (!cancelled && volumeRequestVersion.current === requestVersion) overlayDesiredVisible.current = null;
        });
    };
    const listenerRegistrations = [
      listen<OverlayState>(OVERLAY_STATE_EVENT, ({ payload }) => {
        if (cancelled) return;
        overlayEventVersion.current += 1;
        setOverlay(payload);
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
      listen<HeadTrackerDiagnostic | null>(HEAD_TRACKER_DIAGNOSTIC_EVENT, ({ payload }) => {
        if (!cancelled) telemetryStore.setHeadDiagnostic(payload);
      }),
      listen<null>(SHAKE_DETECTED_EVENT, () => {
        if (!cancelled) setShakeDetections((count) => count + 1);
      }),
      listen<PitchDirection>(PITCH_DETECTED_EVENT, ({ payload }) => {
        if (!cancelled) setLastPitch((previous) => ({ direction: payload, count: (previous?.count ?? 0) + 1 }));
      }),
      listen<RollDirection>(ROLL_DETECTED_EVENT, ({ payload }) => {
        if (!cancelled) setLastRoll((previous) => ({ direction: payload, count: (previous?.count ?? 0) + 1 }));
      }),
      listen<TapKind>(TAP_DETECTED_EVENT, ({ payload }) => {
        if (!cancelled) setLastTap((previous) => ({ kind: payload, count: (previous?.count ?? 0) + 1 }));
      }),
      listen<SwipeDirection>(SWIPE_DETECTED_EVENT, ({ payload }) => {
        if (!cancelled) setLastSwipe((previous) => ({ direction: payload, count: (previous?.count ?? 0) + 1 }));
      }),
      listen<ActionError>(ACTION_ERROR_EVENT, ({ payload }) => {
        if (!cancelled) setActionError(`${payload.action}: ${payload.message}`);
      }),
      listen<AutomationState>(AUTOMATION_STATE_EVENT, ({ payload }) => {
        if (!cancelled) setAutomation(payload);
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
      }),
      listen<CalibrationTarget>(HEAD_TARGET_EXITED_EVENT, ({ payload }) => {
        if (cancelled) return;
        calibrationEventVersion.current += 1;
        setCalibration((current) =>
          current?.activeTarget === payload ? { ...current, activeTarget: null } : current);
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
          if (cancelled || overlayEventVersion.current !== requestedOverlayVersion) return;
          setOverlay(state);
          if (!(state.visible && overlayDesiredVisible.current === false)) {
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
          }
        })
        .catch((error) => {
          if (!cancelled) setCalibrationError(String(error));
        });
      void invoke<AutomationState>("get_automation_state")
        .then((state) => {
          if (!cancelled) setAutomation(state);
        })
        .catch((error) => {
          if (!cancelled) setCalibrationError(String(error));
        });
      void invoke<"native" | "external">("get_head_tracker_provider")
        .then((provider) => {
          if (!cancelled) telemetryStore.setHeadTrackerProvider(provider);
        })
        .catch(() => {});
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
          `${calibration?.targets.find((location) => location.id === target)?.name ?? "Location"} position saved.`,
        );
      } catch (error) {
        setCalibrationError(String(error));
        OperationFeedback.error("Capture calibration target", String(error));
      }
    });
  };

  const locationCommand = (key: string, title: string, success: string, command: string, args: Record<string, unknown>) =>
    run(key, async () => {
      try {
        setCalibrationError(null);
        await invoke<CalibrationState>(command, args);
        OperationFeedback.success(title, success);
      } catch (error) {
        setCalibrationError(String(error));
        OperationFeedback.error(title, String(error));
      }
    });

  const addLocation = async (name: string) => {
    if (!inTauri) return;
    await locationCommand("location:add", "Add location", `${name} added. Capture it to finish.`, "add_calibration_location", { name });
  };

  const removeLocation = async (target: CalibrationTarget) => {
    if (!inTauri) return;
    await locationCommand(`location:remove:${target}`, "Remove location", "Location removed.", "remove_calibration_location", { target });
  };

  const saveRecipe = async (recipe: Recipe): Promise<string | null> => {
    if (!inTauri) return "Saving recipes needs the desktop app.";
    try {
      setAutomation(await invoke<AutomationState>("save_recipe", { recipe }));
      OperationFeedback.success("Save recipe", `${recipe.name} saved.`);
      return null;
    } catch (error) {
      return String(error);
    }
  };

  const deleteRecipe = async (id: string) => {
    if (!inTauri) return;
    await run(`recipe:${id}`, async () => {
      try {
        setCalibrationError(null);
        setAutomation(await invoke<AutomationState>("delete_recipe", { id }));
        OperationFeedback.success("Delete recipe", "Recipe deleted.");
      } catch (error) {
        setCalibrationError(String(error));
        OperationFeedback.error("Delete recipe", String(error));
      }
    });
  };

  const setRecipeEnabled = async (id: string, enabled: boolean) => {
    if (!inTauri) return;
    await run(`recipe:${id}`, async () => {
      try {
        setCalibrationError(null);
        setActionError(null);
        setAutomation(await invoke<AutomationState>("set_recipe_enabled", { id, enabled }));
      } catch (error) {
        setCalibrationError(String(error));
        OperationFeedback.error("Change recipe", String(error));
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

  // The camera follows the recording and adds its landmarks to each bundle, whichever tab is showing.
  useEffect(() => bindCameraToRecording(), []);
  useEffect(() => watchCameraDevices(), []);

  const stableSetRecipeEnabled = useStableCallback((id: string, enabled: boolean) => { void setRecipeEnabled(id, enabled); });
  const stableSaveRecipe = useStableCallback(saveRecipe);
  const stableDeleteRecipe = useStableCallback((id: string) => { void deleteRecipe(id); });
  const clearStartWithDevice = useCallback(() => setStartWithDevice(null), []);
  const openModelLab = useCallback(() => setActiveTab("modelLab"), []);
  const openLabels = useCallback(() => setActiveTab("labels"), []);
  const openSettings = useCallback(() => setActiveTab("settings"), []);
  const makeRecipeFromDevice = useCallback((kind: DeviceKind) => {
    setStartWithDevice(kind);
    setActiveTab("recipes");
  }, []);
  // Which recipes have a change in flight. The pending set lives in a ref, so a memoised Recipes page is told about it
  // through this value instead of reading the ref itself.
  const pendingRecipeKey = (automation?.recipes ?? []).filter((recipe) => isPending(`recipe:${recipe.id}`)).map((recipe) => recipe.id).join(",");
  const pendingRecipeIds = useMemo(() => (pendingRecipeKey === "" ? [] : pendingRecipeKey.split(",")), [pendingRecipeKey]);

  const applicationError = [calibrationError, volumeError, sensorControlError, actionError]
    .filter((error): error is string => error !== null)
    .join(" · ") || null;

  return <SidebarProvider>
    <RecordingTimer />
    <CameraGestureBridge />
    <AppNav
      activeTab={activeTab}
      onSelect={setActiveTab}
      statuses={navStatuses({
        headphonesConnected: status?.connected === true,
        watchConnected: watchStatus?.connected === true,
        watchWorn: watchStatus?.worn ?? null,
        recordingState: telemetryStore.getDatasetRecordingState(),
      })}
    />
    <SidebarInset>
    <Suspense fallback={<TabFallback />}>
    {activeTab === "main" && (
      <Dashboard
        onNavigate={setActiveTab}
        view="main"
        status={status}
        headDiagnostic={headDiagnostic}
        headTrackerProvider={headTrackerProvider}
        calibration={calibration}
        automation={automation}
        onSetRecipeEnabled={(id, enabled) => { void setRecipeEnabled(id, enabled); }}
        calibrationError={applicationError}
        watchStatus={watchStatus}
        isPending={isPending}
        onCaptureTarget={(target) => { void captureTarget(target); }}
        onUpdateCalibration={(threshold, dwell) => { void updateCalibration(threshold, dwell); }}
        onAddLocation={(name) => { void addLocation(name); }}
        onRemoveLocation={(target) => { void removeLocation(target); }}
      />
    )}
    {activeTab === "headphone" && (
      <Dashboard
        view="headphone"
        status={status}
        headDiagnostic={headDiagnostic}
        headTrackerProvider={headTrackerProvider}
        calibration={calibration}
        automation={automation}
        onSetRecipeEnabled={(id, enabled) => { void setRecipeEnabled(id, enabled); }}
        calibrationError={applicationError}
        watchStatus={watchStatus}
        isPending={isPending}
        onCaptureTarget={(target) => { void captureTarget(target); }}
        onUpdateCalibration={(threshold, dwell) => { void updateCalibration(threshold, dwell); }}
        onAddLocation={(name) => { void addLocation(name); }}
        onRemoveLocation={(target) => { void removeLocation(target); }}
      />
    )}
    {activeTab === "watch" && (
      <Dashboard
        view="watch"
        status={status}
        calibration={calibration}
        automation={automation}
        onSetRecipeEnabled={(id, enabled) => { void setRecipeEnabled(id, enabled); }}
        calibrationError={applicationError}
        watchStatus={watchStatus}
        isPending={isPending}
        onCaptureTarget={(target) => { void captureTarget(target); }}
        onUpdateCalibration={(threshold, dwell) => { void updateCalibration(threshold, dwell); }}
        onAddLocation={(name) => { void addLocation(name); }}
        onRemoveLocation={(target) => { void removeLocation(target); }}
        onSetSensorEnabled={(sensor, enabled) => { void setSensorEnabled(sensor, enabled); }}
      />
    )}
    {activeTab === "recipes" && (
      <RecipesPage
        automation={automation}
        calibration={calibration}
        pendingRecipeIds={pendingRecipeIds}
        error={applicationError}
        onSetEnabled={stableSetRecipeEnabled}
        onSave={stableSaveRecipe}
        onDelete={stableDeleteRecipe}
        startWithDevice={startWithDevice}
        builtInGestures={settings?.heuristicGestures}
        onStartHandled={clearStartWithDevice}
      />
    )}
    {activeTab === "devices" && (
      <VirtualDevicesPage
        automation={automation}
        onMakeRecipe={makeRecipeFromDevice}
      />
    )}
    {activeTab === "gestures" && (
      <GesturesPage
        heuristics={settings?.heuristicGestures}
        watchConnected={watchStatus?.connected === true}
        stemDown={watchStatus?.lastButtonState === "down"}
        shakeCount={shakeDetections}
        lastSwipe={lastSwipe}
        lastTap={lastTap}
        lastRoll={lastRoll}
        lastPitch={lastPitch}
        calibration={calibration}
        automation={automation}
        onOpenModelLab={openModelLab}
        onOpenSettings={openSettings}
      />
    )}
    {activeTab === "signals" && <LiveSignalsPage />}
    {activeTab === "recorder" && <RecorderPage />}
    {activeTab === "recordings" && <RecordingsPage />}
    {activeTab === "labels" && <LabelsPage onOpen={setActiveTab} />}
    {activeTab === "gestureLibrary" && <GestureLibraryPage />}
    {activeTab === "modelLab" && (
      <ModelLab onOpenLabels={openLabels} />
    )}
    {activeTab === "settings" && (
      <Settings
        settings={settings}
        error={settingsError}
        isPending={isPending}
        overlay={overlay}
        watchStatus={watchStatus}
        shakeDetections={shakeDetections}
        lastSwipe={lastSwipe}
        lastTap={lastTap}
        lastRoll={lastRoll}
        lastPitch={lastPitch}
        onUpdate={(next) => { void updateSettings(next); }}
        onReset={() => { void resetSettings(); }}
      />
    )}
    </Suspense>
    </SidebarInset>
  </SidebarProvider>;
}
