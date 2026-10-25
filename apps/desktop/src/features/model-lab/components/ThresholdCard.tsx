import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { LabelModel } from "../labelModels";

/** Mirrors `mistakes::ThresholdSweep`. */
export interface ThresholdSweep {
  version: string;
  label: string;
  threshold: number;
  points: { threshold: number; starts: number; caught: number; falseActivations: number; minutes: number }[];
  recordings: number;
}

export const caughtShare = (point: ThresholdSweep["points"][number]) => (point.starts > 0 ? point.caught / point.starts : 0);
export const falsePerMinute = (point: ThresholdSweep["points"][number]) => (point.minutes > 0 ? point.falseActivations / point.minutes : 0);

/** The point nearest `threshold`. */
export function pointAt(sweep: ThresholdSweep, threshold: number) {
  return sweep.points.reduce((best, point) => (Math.abs(point.threshold - threshold) < Math.abs(best.threshold - threshold) ? point : best), sweep.points[0]);
}

const WIDTH = 360;
const HEIGHT = 180;
const PAD = 32;

const SERIES = ["var(--chart-2)", "var(--chart-1)", "var(--chart-3)", "var(--chart-4)"];

/**
 * Caught against false alarms a minute, one dot per threshold, for each model: the trade-off a threshold picks a point on.
 * Each model's own threshold is ringed; `shown` (one model) is the one being looked at.
 */
export function TradeOff({ sweeps, shown }: { sweeps: ThresholdSweep[]; shown?: number }) {
  const most = Math.max(1, ...sweeps.flatMap((sweep) => sweep.points.map(falsePerMinute)));
  const x = (value: number) => PAD + (value / most) * (WIDTH - PAD - 8);
  const y = (share: number) => HEIGHT - PAD - share * (HEIGHT - PAD - 8);
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="threshold-chart" role="img" aria-label="Starts caught against false alarms a minute, at each threshold">
      <line x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - 8} y2={HEIGHT - PAD} className="threshold-axis" />
      <line x1={PAD} y1={8} x2={PAD} y2={HEIGHT - PAD} className="threshold-axis" />
      <text x={PAD} y={HEIGHT - 8} className="threshold-label">0</text>
      <text x={WIDTH - 8} y={HEIGHT - 8} textAnchor="end" className="threshold-label">{most.toFixed(1)} false a minute</text>
      <text x={PAD - 4} y={12} textAnchor="end" className="threshold-label">100%</text>
      <text x={PAD - 4} y={HEIGHT - PAD} textAnchor="end" className="threshold-label">0%</text>
      {sweeps.map((sweep, series) => {
        const color = SERIES[series % SERIES.length];
        const ordered = [...sweep.points].sort((a, b) => falsePerMinute(a) - falsePerMinute(b));
        const own = sweep.points.length > 0 ? pointAt(sweep, sweep.threshold).threshold : null;
        return (
          <g key={sweep.version}>
            <polyline points={ordered.map((point) => `${x(falsePerMinute(point))},${y(caughtShare(point))}`).join(" ")} className="threshold-line" style={{ stroke: color }} />
            {sweep.points.map((point) => {
              const isShown = shown !== undefined && Math.abs(point.threshold - shown) < 1e-6;
              const isOwn = point.threshold === own;
              return (
                <circle
                  key={point.threshold}
                  cx={x(falsePerMinute(point))}
                  cy={y(caughtShare(point))}
                  r={isShown ? 5 : isOwn ? 4 : 2.5}
                  className={isShown ? "threshold-shown" : isOwn ? "threshold-own" : "threshold-point"}
                  style={isShown || isOwn ? undefined : { fill: color }}
                >
                  <title>{`${sweeps.length > 1 ? `${sweep.version} ` : ""}${point.threshold.toFixed(2)}: ${Math.round(caughtShare(point) * 100)}% caught, ${falsePerMinute(point).toFixed(1)} false a minute`}</title>
                </circle>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

/** The colour each model is drawn in, for a legend. */
export const seriesColor = (index: number) => SERIES[index % SERIES.length];

/**
 * What a model's threshold trades: at each threshold from 0.30 to 0.95, how many starts it catches on the recordings it was
 * tested on, and how many false alarms a minute it makes. Its own threshold is one point on that curve.
 */
export function ThresholdCard({ desktopAvailable, models }: { desktopAvailable: boolean; models: LabelModel[] }) {
  const [version, setVersion] = useState("");
  const [sweep, setSweep] = useState<ThresholdSweep | null>(null);
  const [shown, setShown] = useState(0.5);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trained = models.filter((model) => !model.imported && model.state !== "archived");

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await invoke<ThresholdSweep>("threshold_sweep", { versionId: version });
      setSweep(result);
      setShown(pointAt(result, result.threshold).threshold);
    } catch (err) {
      setError(String(err));
      setSweep(null);
    } finally {
      setRunning(false);
    }
  };

  const point = sweep && sweep.points.length > 0 ? pointAt(sweep, shown) : null;
  const own = sweep && sweep.points.length > 0 ? pointAt(sweep, sweep.threshold) : null;
  return (
    <Card id="lab-threshold" role="region" aria-label="Threshold" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Threshold"
          description="What a model's threshold trades: lower catches more starts and fires more often by mistake. Each dot is a threshold, on the recordings the model was tested on; its own is ringed."
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <select aria-label="Model for the threshold" className="recipe-select" value={version} onChange={(event) => setVersion(event.target.value)}>
            <option value="">Choose a model…</option>
            {trained.map((model) => <option key={model.id} value={model.id}>{model.label}: {model.id} ({model.state})</option>)}
          </select>
          <Button type="button" onClick={() => void run()} disabled={!desktopAvailable || running || version === ""} aria-busy={running}>
            {running ? "Working it out…" : "Show the trade-off"}
          </Button>
        </div>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        {sweep && point && own && (
          <>
            <TradeOff sweeps={[sweep]} shown={shown} />
            <label className="flex flex-wrap items-center gap-2">
              Threshold
              <input
                type="range"
                aria-label="Threshold to look at"
                min={sweep.points[0].threshold}
                max={sweep.points[sweep.points.length - 1].threshold}
                step={0.05}
                value={shown}
                onChange={(event) => setShown(Math.round(Number(event.target.value) * 100) / 100)}
              />
              <strong className="font-mono">{shown.toFixed(2)}</strong>
            </label>
            <p role="status">
              At {point.threshold.toFixed(2)}: caught {point.caught} of {point.starts} starts ({Math.round(caughtShare(point) * 100)}%), with {falsePerMinute(point).toFixed(1)} false alarms a minute
              {point.threshold === own.threshold
                ? ". This is the model's own threshold."
                : `, against ${Math.round(caughtShare(own) * 100)}% and ${falsePerMinute(own).toFixed(1)} at its own ${sweep.threshold.toFixed(2)}.`}
            </p>
            <p className="hint">
              Over {sweep.recordings} test recording{sweep.recordings === 1 ? "" : "s"}, from one run of the model's scores through its detection rule at each threshold. The threshold is part of a trained model: to use another, train again.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
