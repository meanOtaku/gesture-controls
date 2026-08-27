import { useRef } from "react";
import type { AppSettings } from "../../../shared/protocol/events";

interface SettingsProps {
  settings: AppSettings | null;
  error?: string | null;
  onUpdate: (settings: AppSettings) => void;
  onReset: () => void;
}

/** Mirrors `spatial_protocol::CONTROLLABLE_SENSOR_IDS`. */
const CONTROLLABLE_SENSORS: Array<{ id: string; label: string }> = [
  { id: "orientation", label: "Orientation (rotation vector)" },
  { id: "acceleration", label: "Accelerometer" },
  { id: "gyroscope", label: "Gyroscope" },
  { id: "heart_rate_continuous", label: "Heart rate" },
  { id: "skin_temperature_continuous", label: "Skin temperature" },
  { id: "eda_continuous", label: "EDA" },
];

/** Mirrors `AppSettings::default()` in `apps/desktop/src-tauri/src/settings.rs`, used only until the real settings load. */
const DEFAULT_SETTINGS: AppSettings = {
  headphonesEnabled: true,
  headphonesRateHz: 60,
  recordingRateHz: 30,
  graphRefreshRateHz: 15,
  watchOrientationRateHz: 50,
  watchAccelerationRateHz: 50,
  watchGyroscopeRateHz: 50,
  watchPpgFlushRateHz: 1,
  watchHeartRateAcceptanceRateHz: 200,
  watchSkinTemperatureAcceptanceRateHz: 200,
  watchEdaAcceptanceRateHz: 200,
  watchSensorsEnabled: Object.fromEntries(CONTROLLABLE_SENSORS.map(({ id }) => [id, true])),
};

function clamp(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function Settings({ settings, error, onUpdate, onReset }: SettingsProps) {
  const current = settings ?? DEFAULT_SETTINGS;
  const headphonesRateInput = useRef<HTMLInputElement>(null);
  const recordingRateInput = useRef<HTMLInputElement>(null);
  const graphRefreshRateInput = useRef<HTMLInputElement>(null);
  const watchOrientationRateInput = useRef<HTMLInputElement>(null);
  const watchAccelerationRateInput = useRef<HTMLInputElement>(null);
  const watchGyroscopeRateInput = useRef<HTMLInputElement>(null);
  const watchPpgFlushRateInput = useRef<HTMLInputElement>(null);
  const watchHeartRateAcceptanceRateInput = useRef<HTMLInputElement>(null);
  const watchSkinTemperatureAcceptanceRateInput = useRef<HTMLInputElement>(null);
  const watchEdaAcceptanceRateInput = useRef<HTMLInputElement>(null);

  const commitRates = () => {
    onUpdate({
      ...current,
      headphonesRateHz: clamp(headphonesRateInput.current?.value, 1, 200, current.headphonesRateHz),
      recordingRateHz: clamp(recordingRateInput.current?.value, 1, 200, current.recordingRateHz),
      graphRefreshRateHz: clamp(graphRefreshRateInput.current?.value, 1, 60, current.graphRefreshRateHz),
      watchOrientationRateHz: clamp(watchOrientationRateInput.current?.value, 1, 200, current.watchOrientationRateHz),
      watchAccelerationRateHz: clamp(watchAccelerationRateInput.current?.value, 1, 200, current.watchAccelerationRateHz),
      watchGyroscopeRateHz: clamp(watchGyroscopeRateInput.current?.value, 1, 200, current.watchGyroscopeRateHz),
      watchPpgFlushRateHz: clamp(watchPpgFlushRateInput.current?.value, 0.1, 10, current.watchPpgFlushRateHz),
      watchHeartRateAcceptanceRateHz: clamp(watchHeartRateAcceptanceRateInput.current?.value, 0.1, 200, current.watchHeartRateAcceptanceRateHz),
      watchSkinTemperatureAcceptanceRateHz: clamp(watchSkinTemperatureAcceptanceRateInput.current?.value, 0.1, 200, current.watchSkinTemperatureAcceptanceRateHz),
      watchEdaAcceptanceRateHz: clamp(watchEdaAcceptanceRateInput.current?.value, 0.1, 200, current.watchEdaAcceptanceRateHz),
    });
  };

  const toggleHeadphonesEnabled = () => onUpdate({ ...current, headphonesEnabled: !current.headphonesEnabled });
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

      {error && <p className="calibration-error" role="alert">{error}</p>}

      <section className="calibration-card" aria-label="Headphones settings">
        <div className="calibration-heading">
          <div><p className="eyebrow">Headphones</p><h2>Acceptance rate</h2></div>
        </div>
        <p className="hint">Every incoming Sony packet still updates calibration and connection state; this only throttles what's displayed and recorded.</p>
        <div className="calibration-actions">
          <button onClick={toggleHeadphonesEnabled}>
            {current.headphonesEnabled ? "Enabled" : "Disabled"}
            <small>Click to {current.headphonesEnabled ? "disable" : "enable"}</small>
          </button>
          <label>
            Headphones rate
            <input
              aria-label="Headphones rate Hz"
              type="number"
              min="1"
              max="200"
              step="1"
              ref={headphonesRateInput}
              key={`headphones-rate-${current.headphonesRateHz}`}
              defaultValue={current.headphonesRateHz}
            />
            <small>Hz</small>
          </label>
        </div>
      </section>

      <section className="calibration-card" aria-label="Recording and graph settings">
        <div className="calibration-heading">
          <div><p className="eyebrow">Live data</p><h2>Recording &amp; graph</h2></div>
        </div>
        <div className="calibration-actions">
          <label>
            Recording rate
            <input
              aria-label="Recording rate Hz"
              type="number"
              min="1"
              max="200"
              step="1"
              ref={recordingRateInput}
              key={`recording-rate-${current.recordingRateHz}`}
              defaultValue={current.recordingRateHz}
            />
            <small>Hz, per channel</small>
          </label>
          <label>
            Graph refresh rate
            <input
              aria-label="Graph refresh rate Hz"
              type="number"
              min="1"
              max="60"
              step="1"
              ref={graphRefreshRateInput}
              key={`graph-refresh-rate-${current.graphRefreshRateHz}`}
              defaultValue={current.graphRefreshRateHz}
            />
            <small>Hz</small>
          </label>
        </div>
      </section>

      <section className="calibration-card" aria-label="Watch sensor rates">
        <div className="calibration-heading">
          <div><p className="eyebrow">Galaxy Watch</p><h2>IMU sampling rates</h2></div>
        </div>
        <p className="hint">Applied live via Android SensorManager without restarting the stream.</p>
        <div className="calibration-actions">
          <label>
            Orientation
            <input
              aria-label="Watch orientation rate Hz"
              type="number"
              min="1"
              max="200"
              step="1"
              ref={watchOrientationRateInput}
              key={`watch-orientation-rate-${current.watchOrientationRateHz}`}
              defaultValue={current.watchOrientationRateHz}
            />
            <small>Hz</small>
          </label>
          <label>
            Acceleration
            <input
              aria-label="Watch acceleration rate Hz"
              type="number"
              min="1"
              max="200"
              step="1"
              ref={watchAccelerationRateInput}
              key={`watch-acceleration-rate-${current.watchAccelerationRateHz}`}
              defaultValue={current.watchAccelerationRateHz}
            />
            <small>Hz</small>
          </label>
          <label>
            Gyroscope
            <input
              aria-label="Watch gyroscope rate Hz"
              type="number"
              min="1"
              max="200"
              step="1"
              ref={watchGyroscopeRateInput}
              key={`watch-gyroscope-rate-${current.watchGyroscopeRateHz}`}
              defaultValue={current.watchGyroscopeRateHz}
            />
            <small>Hz</small>
          </label>
        </div>
      </section>

      <section className="calibration-card" aria-label="Samsung health delivery controls">
        <div className="calibration-heading">
          <div><p className="eyebrow">Galaxy Watch</p><h2>Samsung health delivery controls</h2></div>
        </div>
        <p className="hint">PPG controls the existing HealthTracker.flush() frequency. The other values limit desktop graph and recording acceptance. Samsung still controls physical sampling.</p>
        <div className="calibration-actions">
          <label>
            Raw PPG flush
            <input aria-label="Watch PPG flush rate Hz" type="number" min="0.1" max="10" step="0.1"
              ref={watchPpgFlushRateInput} key={`watch-ppg-flush-${current.watchPpgFlushRateHz}`}
              defaultValue={current.watchPpgFlushRateHz} />
            <small>Hz</small>
          </label>
          <label>
            Heart rate
            <input aria-label="Watch heart rate acceptance rate Hz" type="number" min="0.1" max="200" step="0.1"
              ref={watchHeartRateAcceptanceRateInput} key={`watch-heart-rate-acceptance-${current.watchHeartRateAcceptanceRateHz}`}
              defaultValue={current.watchHeartRateAcceptanceRateHz} />
            <small>Hz</small>
          </label>
          <label>
            Skin temperature
            <input aria-label="Watch skin temperature acceptance rate Hz" type="number" min="0.1" max="200" step="0.1"
              ref={watchSkinTemperatureAcceptanceRateInput} key={`watch-temperature-acceptance-${current.watchSkinTemperatureAcceptanceRateHz}`}
              defaultValue={current.watchSkinTemperatureAcceptanceRateHz} />
            <small>Hz</small>
          </label>
          <label>
            EDA
            <input aria-label="Watch EDA acceptance rate Hz" type="number" min="0.1" max="200" step="0.1"
              ref={watchEdaAcceptanceRateInput} key={`watch-eda-acceptance-${current.watchEdaAcceptanceRateHz}`}
              defaultValue={current.watchEdaAcceptanceRateHz} />
            <small>Hz</small>
          </label>
        </div>
      </section>

      <section className="watch-card" aria-label="Watch sensor enable switches">
        <div className="calibration-heading"><div><p className="eyebrow">Galaxy Watch</p><h2>Sensor switches</h2></div></div>
        <div className="vectors">
          {CONTROLLABLE_SENSORS.map(({ id, label }) => {
            const enabled = current.watchSensorsEnabled[id] ?? true;
            return (
              <div className="vector-row sensor-toggle-row" key={id}>
                <span className="label">{label}</span>
                <span>{enabled ? "Enabled" : "Disabled"}</span>
                <div className="recording-actions">
                  <button onClick={() => toggleWatchSensor(id)}>{enabled ? "Disable" : "Enable"}</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="settings" aria-label="Apply or reset settings">
        <div>
          <p className="eyebrow">Runtime configuration</p>
          <h2>Apply rate changes</h2>
          <p className="hint">Applies every edited rate to its corresponding desktop or Watch stream.</p>
        </div>
        <div className="recording-actions">
          <button onClick={commitRates}>Apply rates</button>
          <button onClick={onReset}>Reset to defaults</button>
        </div>
      </section>
    </main>
  );
}
