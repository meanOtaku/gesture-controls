import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { watchPower, type PowerRates, type WatchMeasurement } from "../../../shared/tauri/watchPower";

const fixed = (value: number | null | undefined, digits = 1) => (value === null || value === undefined || !Number.isFinite(value) ? "–" : value.toFixed(digits));
const minutes = (seconds: number) => `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;

/** The figures that matter for battery, in one line each. */
export function describeRates(rates: PowerRates): { title: string; value: string; hint?: string }[] {
  const motion = rates.sensors.filter((sensor) => sensor.registered);
  return [
    { title: "Average draw", value: `${fixed(rates.averageDrawMa)} mA`, hint: "From the battery's charge counter." },
    { title: "Battery", value: `${fixed(rates.batteryPercentPerHour)} % an hour`, hint: "From the percentage: only meaningful over tens of minutes." },
    { title: "CPU", value: `${fixed(rates.cpuPercent)} %`, hint: "The watch app's share of one core." },
    { title: "Sensor wakes", value: `${fixed(rates.sensorDeliveriesPerSecond, 0)} a second`, hint: "How often motion events reached the app: what hardware batching cuts." },
    ...motion.map((sensor) => ({
      title: sensor.id.charAt(0).toUpperCase() + sensor.id.slice(1),
      value: `${fixed(sensor.achievedHz, 0)} Hz${sensor.requestedHz ? ` of ${fixed(sensor.requestedHz, 0)} asked` : ""}`,
      hint: `${sensor.name}. Batching buffer: ${sensor.fifoMaxEvents === 0 ? "none (this sensor cannot batch)" : `${sensor.fifoMaxEvents} events`}.`,
    })),
    { title: "Pulse", value: `${fixed(rates.ppgHz, 0)} Hz, ${fixed(rates.ppgDeliveriesPerSecond, 1)} deliveries a second` },
    { title: "Link", value: `${fixed(rates.messagesPerSecond, 0)} messages, ${fixed(rates.bytesPerSecond / 1024, 1)} KB a second`, hint: `${rates.droppedMessages} dropped, ${rates.refusedSends} refused over this stretch.` },
    ...(rates.temperatureC !== null ? [{ title: "Battery temperature", value: `${fixed(rates.temperatureC)} °C` }] : []),
  ];
}

/**
 * What streaming costs the watch: its battery draw, CPU, how often the sensors wake it, each sensor's real rate and what
 * goes over the link, from the counters it reports. A measurement is a stretch you start and stop, kept to compare with
 * others: run one with the watch off its charger, then change one thing and run another.
 */
export function WatchPowerCard() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const view = useSyncExternalStore(watchPower.subscribe, watchPower.get, watchPower.get);
  const [label, setLabel] = useState("");
  const [measurements, setMeasurements] = useState<WatchMeasurement[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      setMeasurements(await invoke<WatchMeasurement[]>("list_watch_measurements"));
    } catch (err) {
      setError(String(err));
    }
  }, [desktopAvailable]);
  useEffect(() => void load(), [load]);

  const start = async () => {
    setError(null);
    try {
      watchPower.set(await invoke("start_watch_measurement", { label }));
    } catch (err) {
      setError(String(err));
    }
  };
  const stop = async () => {
    setError(null);
    try {
      await invoke<WatchMeasurement>("stop_watch_measurement");
      watchPower.set({ ...view, run: null });
      setLabel("");
      await load();
    } catch (err) {
      setError(String(err));
    }
  };
  const remove = async (id: string) => {
    try {
      setMeasurements(await invoke<WatchMeasurement[]>("delete_watch_measurement", { id }));
    } catch (err) {
      setError(String(err));
    }
  };

  const run = view.run;
  return (
    <Card role="region" aria-label="Watch power" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Watch power"
          description="What streaming costs the watch, from the counters it reports every few seconds. Nothing here changes what the watch does."
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {!view.reporting ? (
          <p className="hint">
            {desktopAvailable ? "The watch has not reported its power use: connect it with a build of the watch app that reports it." : "Watch power is read through the desktop app."}
          </p>
        ) : view.live ? (
          <>
            <p className="hint">Over the last {minutes(view.live.seconds)}:</p>
            {view.live.charging && <Alert role="note"><AlertDescription>The watch is charging: its battery figures do not count.</AlertDescription></Alert>}
            <dl className="power-grid">
              {describeRates(view.live).map((row) => (
                <div key={row.title} title={row.hint}>
                  <dt>{row.title}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <p className="hint">Waiting for a second report to work out rates.</p>
        )}

        <section aria-label="Measurement" className="flex flex-col gap-2">
          <h3 className="label">Measure</h3>
          <p className="hint">
            Take the watch off its charger, start a measurement, and leave it streaming for 30 minutes or more. Then change
            one thing (a setting, a build) and measure again. Battery figures need at least 10 minutes; longer is better.
          </p>
          {run ? (
            <div className="flex flex-wrap items-center gap-3">
              <span>
                <strong>{run.label}</strong>: {run.rates ? `${minutes(run.rates.seconds)} so far, ${fixed(run.rates.averageDrawMa)} mA` : "waiting for the watch's next report"}
              </span>
              <Button type="button" onClick={() => void stop()}>Stop and keep</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Input aria-label="Measurement name" placeholder="e.g. desk, batching off" className="max-w-xs" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} />
              <Button type="button" disabled={!desktopAvailable} onClick={() => void start()}>Start measuring</Button>
            </div>
          )}
          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
          {measurements.length > 0 && (
            <table className="compare-table" aria-label="Measurements">
              <thead>
                <tr>
                  <th>Measurement</th>
                  <th>Length</th>
                  <th>Draw</th>
                  <th>Battery</th>
                  <th>CPU</th>
                  <th>Wakes</th>
                  <th>Motion delay</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...measurements].reverse().map((measurement) => (
                  <tr key={measurement.id}>
                    <td>
                      {measurement.label} <small className="text-muted-foreground">{measurement.startedAt.slice(0, 16).replace("T", " ")}</small>
                      {measurement.notes.length > 0 && <div className="text-xs text-destructive">{measurement.notes.join(" ")}</div>}
                    </td>
                    <td>{measurement.rates ? minutes(measurement.rates.seconds) : "–"}</td>
                    <td>{fixed(measurement.rates?.averageDrawMa)} mA</td>
                    <td>{fixed(measurement.rates?.batteryPercentPerHour)} %/h</td>
                    <td>{fixed(measurement.rates?.cpuPercent)} %</td>
                    <td>{fixed(measurement.rates?.sensorDeliveriesPerSecond, 0)}/s</td>
                    <td>{fixed(measurement.delayP50Ms, 0)} / {fixed(measurement.delayP95Ms, 0)} ms</td>
                    <td><Button type="button" size="sm" variant="ghost" aria-label={`Delete ${measurement.label}`} onClick={() => void remove(measurement.id)}>Delete</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
