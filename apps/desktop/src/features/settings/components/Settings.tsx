import type { FormEvent } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { useNumberDrafts } from "../../../shared/forms/useNumberDrafts";
import type { AppSettings, HeuristicGesture } from "../../../shared/protocol/events";
import { AdvancedSection } from "../../../components/app/AdvancedSection";
import { ApplySettingsFooter } from "./ApplySettingsFooter";
import { AppearanceSection } from "./AppearanceSection";
import { BuiltInGesturesSection } from "./BuiltInGesturesSection";
import { SteadyStartsSection } from "./SteadyStartsSection";
import { HeadphonesSettingsSection } from "./HeadphonesSettingsSection";
import { RecordingGraphSettingsSection } from "./RecordingGraphSettingsSection";
import { SensitivitySection } from "./SensitivitySection";
import { SettingsGroup, SettingsNav } from "./SettingsGroups";
import { WatchHealthDeliverySettingsSection } from "./WatchHealthDeliverySettingsSection";
import { WatchRateSettingsSection } from "./WatchRateSettingsSection";
import { WatchSensorSwitchSection } from "./WatchSensorSwitchSection";
import { WatchOrientationSettings } from "./WatchOrientationSettings";
import { WatchTransportSection } from "./WatchTransportSection";
import { WristRotationSettings } from "./WristRotationSettings";
import { DEFAULT_SETTINGS, SETTINGS_FIELDS, numericValues } from "../settingsFields";
import { SettingsFormProvider, settingInputId } from "../settingsForm";

interface SettingsProps {
  settings: AppSettings | null;
  error?: string | null;
  /** Reports whether the operation for the given key (`settings:apply`, `settings:reset`) is in flight. */
  isPending?: (key: string) => boolean;
  onUpdate: (settings: AppSettings) => void;
  onReset: () => void;
}

/** The folded section of rarely changed rates and limits. */
const ADVANCED_ID = "settings-advanced";

export function Settings({
  settings,
  error,
  isPending = () => false,
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
      const id = settingInputId(result.firstInvalid);
      const field = document.getElementById(id);
      if (field) field.focus();
      else {
        // The field is folded away under Advanced: open it, then focus the field once it is drawn.
        const advanced = document.getElementById(ADVANCED_ID);
        if (advanced instanceof HTMLDetailsElement) advanced.open = true;
        window.setTimeout(() => document.getElementById(id)?.focus(), 50);
      }
      return;
    }
    onUpdate({ ...current, ...result.values });
  };

  const toggleHeadphonesEnabled = () => onUpdate({ ...current, headphonesEnabled: !current.headphonesEnabled });
  const toggleBuiltInGesture = (gesture: HeuristicGesture) =>
    onUpdate({
      ...current,
      heuristicGestures: { ...current.heuristicGestures, [gesture]: !(current.heuristicGestures[gesture] ?? true) },
    });
  const toggleWatchSensor = (id: string) =>
    onUpdate({
      ...current,
      watchSensorsEnabled: { ...current.watchSensorsEnabled, [id]: !(current.watchSensorsEnabled[id] ?? true) },
    });

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <h1>Settings</h1>
          <p className="subtitle">Typed values apply with Apply changes; switches apply at once.</p>
        </div>
      </header>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <SettingsNav />

      <SettingsFormProvider value={drafts}>
        <form noValidate aria-label="Settings" className="flex flex-col gap-10" onSubmit={submit}>
          <SettingsGroup id="watch">
            <WatchTransportSection
              selected={current.watchTransport}
              onSelect={(watchTransport) => onUpdate({ ...current, watchTransport })}
            />
            <WatchOrientationSettings
              crownSide={current.crownSide}
              wrist={current.watchWrist}
              onCrownSideChange={(crownSide) => onUpdate({ ...current, crownSide })}
              onWristChange={(watchWrist) => onUpdate({ ...current, watchWrist })}
            />
            <WatchSensorSwitchSection watchSensorsEnabled={current.watchSensorsEnabled} onToggle={toggleWatchSensor} />
          </SettingsGroup>

          <SettingsGroup id="gestures">
            <BuiltInGesturesSection gestures={current.heuristicGestures} onToggle={toggleBuiltInGesture} />
            <SteadyStartsSection
              enabled={current.steadyStartsOnly}
              onToggle={() => onUpdate({ ...current, steadyStartsOnly: !current.steadyStartsOnly })}
              buzzWhenReady={current.buzzWhenReady}
              onToggleBuzz={() => onUpdate({ ...current, buzzWhenReady: !current.buzzWhenReady })}
              readinessMotion={current.readinessMotion}
              onReadinessMotionChange={(readinessMotion) => onUpdate({ ...current, readinessMotion })}
            />
            <SensitivitySection />
          </SettingsGroup>

          <SettingsGroup id="headphones">
            <HeadphonesSettingsSection enabled={current.headphonesEnabled} onToggleEnabled={toggleHeadphonesEnabled} />
          </SettingsGroup>

          <AdvancedSection id={ADVANCED_ID} storageKey="settings" summary="Sensor, recording and graph rates, and wrist rotation limits">
            <WatchRateSettingsSection />
            <WatchHealthDeliverySettingsSection />
            <RecordingGraphSettingsSection />
            <WristRotationSettings />
          </AdvancedSection>

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

      {/* Outside the form: a theme applies at once, with nothing to apply or discard. */}
      <SettingsGroup id="appearance">
        <AppearanceSection />
      </SettingsGroup>
    </main>
  );
}
