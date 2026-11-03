import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { cohortNote, duringGestures, FALSE_ACTIVATIONS_BUDGET_PER_HOUR, type Judged, perHour, withinBudget } from "../detectorEvents";
import type { LabelModel } from "../labelModels";

/** Mirrors `mistakes::ThresholdPoint`: judged on the camera-timed recordings when there are enough of them. */
export type ThresholdPoint = Judged & { threshold: number };

/** Mirrors `mistakes::ThresholdSweep`. */
export interface ThresholdSweep {
  version: string;
  label: string;
  threshold: number;
  points: ThresholdPoint[];
  recordings: number;
  budgetPerHour: number;
}

export const caughtShare = (point: ThresholdPoint) => (point.starts > 0 ? point.caught / point.starts : 0);
/** False activations an hour with no gesture under way (0 with no such time). */
export const falsePerHour = (point: ThresholdPoint) => point.falseActivationsPerHour ?? 0;

/** The point nearest `threshold`. */
export function pointAt(sweep: ThresholdSweep, threshold: number) {
  return sweep.points.reduce((best, point) => (Math.abs(point.threshold - threshold) < Math.abs(best.threshold - threshold) ? point : best), sweep.points[0]);
}

const WIDTH = 360;
const HEIGHT = 180;
const PAD = 32;

const SERIES = ["var(--chart-2)", "var(--chart-1)", "var(--chart-3)", "var(--chart-4)"];

/**
 * Caught against false activations an hour with no gesture under way, one dot per threshold, for each model: the trade-off
 * a threshold picks a point on. The release gate's budget is the dashed line: a threshold right of it fires too often.
 * Each model's own threshold is ringed; `shown` (one model) is the one being looked at.
 */
export function TradeOff({ sweeps, shown }: { sweeps: ThresholdSweep[]; shown?: number }) {
  const budget = sweeps[0]?.budgetPerHour ?? FALSE_ACTIVATIONS_BUDGET_PER_HOUR;
  const most = Math.max(budget * 2, ...sweeps.flatMap((sweep) => sweep.points.map(falsePerHour)));
  const x = (value: number) => PAD + (value / most) * (WIDTH - PAD - 8);
  const y = (share: number) => HEIGHT - PAD - share * (HEIGHT - PAD - 8);
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="threshold-chart" role="img" aria-label="Starts caught against false activations an hour with no gesture under way, at each threshold">
      <line x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - 8} y2={HEIGHT - PAD} className="threshold-axis" />
      <line x1={PAD} y1={8} x2={PAD} y2={HEIGHT - PAD} className="threshold-axis" />
      <line x1={x(budget)} y1={8} x2={x(budget)} y2={HEIGHT - PAD} className="threshold-budget" data-testid="threshold-budget">
        <title>{`The budget: ${budget} false activations an hour with no gesture under way`}</title>
      </line>
      <text x={x(budget) + 3} y={16} className="threshold-budget-label">budget {budget}/h</text>
      <text x={PAD} y={HEIGHT - 8} className="threshold-label">0</text>
      <text x={WIDTH - 8} y={HEIGHT - 8} textAnchor="end" className="threshold-label">{Math.round(most)} false an hour</text>
      <text x={PAD - 4} y={12} textAnchor="end" className="threshold-label">100%</text>
      <text x={PAD - 4} y={HEIGHT - PAD} textAnchor="end" className="threshold-label">0%</text>
      {sweeps.map((sweep, series) => {
        const color = SERIES[series % SERIES.length];
        const ordered = [...sweep.points].sort((a, b) => falsePerHour(a) - falsePerHour(b));
        const own = sweep.points.length > 0 ? pointAt(sweep, sweep.threshold).threshold : null;
        return (
          <g key={sweep.version}>
            <polyline points={ordered.map((point) => `${x(falsePerHour(point))},${y(caughtShare(point))}`).join(" ")} className="threshold-line" style={{ stroke: color }} />
            {sweep.points.map((point) => {
              const isShown = shown !== undefined && Math.abs(point.threshold - shown) < 1e-6;
              const isOwn = point.threshold === own;
              return (
                <circle
                  key={point.threshold}
                  cx={x(falsePerHour(point))}
                  cy={y(caughtShare(point))}
                  r={isShown ? 5 : isOwn ? 4 : 2.5}
                  className={isShown ? "threshold-shown" : isOwn ? "threshold-own" : "threshold-point"}
                  style={isShown || isOwn ? undefined : { fill: color }}
                >
                  <title>{`${sweeps.length > 1 ? `${sweep.version} ` : ""}${point.threshold.toFixed(2)}: ${Math.round(caughtShare(point) * 100)}% caught, ${Math.round(falsePerHour(point))} false an hour`}</title>
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
 * tested on, and how many false activations an hour with no gesture under way it makes, against the release gate's budget.
 * Its own threshold is one point on that curve.
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
          description="What a model's threshold trades: lower catches more starts and fires more often with no gesture under way. Each dot is a threshold, on the recordings the model was tested on; its own is ringed, and the dashed line is the budget a model must stay within to go live."
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
              At {point.threshold.toFixed(2)}: caught {point.caught} of {point.starts} starts ({Math.round(caughtShare(point) * 100)}%), with {perHour(point)} false activations an hour with no gesture under way
              {withinBudget(point, sweep.budgetPerHour) ? ` (within the ${sweep.budgetPerHour} an hour budget)` : ` (over the ${sweep.budgetPerHour} an hour budget)`}
              {duringGestures(point) ? `; ${duringGestures(point)}` : ""}
              {point.threshold === own.threshold
                ? ". This is the model's own threshold."
                : `, against ${Math.round(caughtShare(own) * 100)}% and ${perHour(own)} at its own ${sweep.threshold.toFixed(2)}.`}
            </p>
            {cohortNote(point) && <p className="hint" aria-label="Label timing">{cohortNote(point)}</p>}
            <p className="hint">
              Over {sweep.recordings} test recording{sweep.recordings === 1 ? "" : "s"} ({Math.round(point.negativeSeconds / 60)} minutes with no gesture under way), from one run of the model's scores through its detection rule at each threshold. A repeat fired again during a pinch it had caught; a late one fired during a pinch it missed. Neither is a false activation. The threshold is part of a trained model: to use another, train again.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
