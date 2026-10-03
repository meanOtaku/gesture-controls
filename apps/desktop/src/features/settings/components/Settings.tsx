import type { FormEvent } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { useNumberDrafts } from "../../../shared/forms/useNumberDrafts";
import type { AppSettings, OverlayState, WatchStatus } from "../../../shared/protocol/events";
import { ApplySettingsFooter } from "./ApplySettingsFooter";
import { CornerWristVolumeDemoSection } from "./CornerWristVolumeDemoSection";
import { CornerWristVolumeDiagnosticsSection } from "./CornerWristVolumeDiagnosticsSection";
import { HeadphonesSettingsSection } from "./HeadphonesSettingsSection";
import { RecordingGraphSettingsSection } from "./RecordingGraphSettingsSection";
import { WatchHealthDeliverySettingsSection } from "./WatchHealthDeliverySettingsSection";
import { WatchRateSettingsSection } from "./WatchRateSettingsSection";
import { WatchSensorSwitchSection } from "./WatchSensorSwitchSection";
import { WatchTransportSection } from "./WatchTransportSection";
import { WristRotationSettings } from "./WristRotationSettings";
import { DEFAULT_SETTINGS, SETTINGS_FIELDS, numericValues } from "../settingsFields";
import { SettingsFormProvider, settingInputId } from "../settingsForm";

const EMPTY_OVERLAY_STATE: OverlayState = {
  visible: false,
  grabbed: false,
  volume: 50,
  rotationAngle: 0,
  screenX: 0,
  screenY: 0,
  cornerDemoPhase: null,
  lastRelativeRollDegrees: null,
  lastNativeVolumeError: null,
};

interface SettingsProps {
  settings: AppSettings | null;
  error?: string | null;
  /** Reports whether the operation for the given key (`settings:apply`, `settings:reset`) is in flight. */
  isPending?: (key: string) => boolean;
  overlay?: OverlayState;
  watchStatus?: WatchStatus | null;
  onUpdate: (settings: AppSettings) => void;
  onReset: () => void;
}

export function Settings({
  settings,
  error,
  isPending = () => false,
  overlay = EMPTY_OVERLAY_STATE,
  watchStatus = null,
  onUpdate,
  onReset,
}: SettingsProps) {
  const current = settings ?? DEFAULT_SETTINGS;
  const drafts = useNumberDrafts(SETTINGS_FIELDS, numericValues(current));

  // Validates every edited field at once. An invalid value is never applied or quietly replaced: the
  // fields say what is wrong and focus goes to the first one.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = drafts.submit();
    if (result.values === null) {
      document.getElementById(settingInputId(result.firstInvalid))?.focus();
      return;
    }
    onUpdate({ ...current, ...result.values });
  };

  const toggleHeadphonesEnabled = () => onUpdate({ ...current, headphonesEnabled: !current.headphonesEnabled });
  const toggleCornerWristVolumeDemoEnabled = () =>
    onUpdate({ ...current, cornerWristVolumeDemoEnabled: !current.cornerWristVolumeDemoEnabled });
  const toggleCornerWristVolumeInvertDirection = () =>
    onUpdate({ ...current, cornerWristVolumeInvertDirection: !current.cornerWristVolumeInvertDirection });
  const toggleWatchSensor = (id: string) =>
    onUpdate({
      ...current,
      watchSensorsEnabled: { ...current.watchSensorsEnabled, [id]: !(current.watchSensorsEnabled[id] ?? true) },
    });

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Settings</h1>
          <p className="subtitle">Edit acceptance, recording, and sampling rates, then apply them together without restarting. Sensor switches remain immediate.</p>
        </div>
      </header>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <SettingsFormProvider value={drafts}>
        <form noValidate aria-label="Settings" className="flex flex-col gap-8" onSubmit={submit}>
          <HeadphonesSettingsSection enabled={current.headphonesEnabled} onToggleEnabled={toggleHeadphonesEnabled} />

          <WristRotationSettings />

          <RecordingGraphSettingsSection />

          <WatchTransportSection
            selected={current.watchTransport}
            onSelect={(watchTransport) => onUpdate({ ...current, watchTransport })}
          />

          <WatchRateSettingsSection />

          <WatchHealthDeliverySettingsSection />

          <WatchSensorSwitchSection watchSensorsEnabled={current.watchSensorsEnabled} onToggle={toggleWatchSensor} />

          <CornerWristVolumeDemoSection
            enabled={current.cornerWristVolumeDemoEnabled}
            invertDirection={current.cornerWristVolumeInvertDirection}
            onToggleEnabled={toggleCornerWristVolumeDemoEnabled}
            onToggleInvertDirection={toggleCornerWristVolumeInvertDirection}
          />

          {current.cornerWristVolumeDemoEnabled && (
            <CornerWristVolumeDiagnosticsSection
              overlay={overlay}
              watchStatus={watchStatus}
              invertDirection={current.cornerWristVolumeInvertDirection}
            />
          )}

          <ApplySettingsFooter
            dirtyCount={drafts.dirtyCount}
            invalidCount={drafts.invalidCount}
            applyPending={isPending("settings:apply")}
            resetPending={isPending("settings:reset")}
            onDiscard={drafts.discard}
            onReset={onReset}
          />
        </form>
      </SettingsFormProvider>
    </main>
  );
}
