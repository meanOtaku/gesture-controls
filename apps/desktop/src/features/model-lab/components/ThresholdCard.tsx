import { AnimatedNumber } from "../../../components/app/AnimatedNumber";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { cohortNote, duringGestures, FALSE_ACTIVATIONS_BUDGET_PER_HOUR, type Judged, perHour, withinBudget } from "../detectorEvents";
import { formatTime, modelName, type LabelModel } from "../labelModels";

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
 * What a model's threshold trades, and setting it: at each threshold from 0.30 to 0.99, how many starts it catches on the
 * recordings it was tested on and how many false activations an hour with no gesture under way it makes, against the
 * release gate's budget. Pick a point and use it: the model runs with that threshold from then on (live, if it is active),
 * and the change is kept in its history. An imported model's test recordings are not known, so it has no curve, only the
 * number.
 */
export function ThresholdCard({ desktopAvailable, models }: { desktopAvailable: boolean; models: LabelModel[] }) {
  const [version, setVersion] = useState("");
  const [sweep, setSweep] = useState<ThresholdSweep | null>(null);
  const [shown, setShown] = useState(0.5);
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmOver, setConfirmOver] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choices = models.filter((model) => model.state !== "archived");
  const model = choices.find((entry) => entry.id === version) ?? null;
  const current = model?.activation ?? null;
  const last = model?.thresholdChanges?.at(-1) ?? null;

  const choose = (id: string) => {
    setVersion(id);
    setSweep(null);
    setError(null);
    setApplied(null);
    setConfirmOver(false);
    setTyped("");
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    setApplied(null);
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

  const apply = async (activation: number) => {
    if (!model) return;
    setApplying(true);
    setError(null);
    try {
      await invoke("set_label_model_threshold", { id: model.id, activation });
      setApplied(`${modelName(model)} now runs at ${activation.toFixed(2)}${model.active ? ", from now on" : ""}.`);
      setSweep((previous) => (previous ? { ...previous, threshold: activation } : previous));
      setConfirmOver(false);
      setTyped("");
    } catch (err) {
      setError(String(err));
    } finally {
      setApplying(false);
    }
  };

  const points = sweep?.points ?? [];
  const index = points.length > 0 ? points.indexOf(pointAt(sweep!, shown)) : 0;
  const point = sweep && points.length > 0 ? pointAt(sweep, shown) : null;
  const own = sweep && points.length > 0 ? pointAt(sweep, sweep.threshold) : null;
  const over = point !== null && sweep !== null && !withinBudget(point, sweep.budgetPerHour);
  const typedValue = typed.trim() === "" ? null : Number(typed);
  const typedOk = typedValue !== null && Number.isFinite(typedValue) && typedValue > 0 && typedValue <= 1;
  return (
    <Card id="lab-threshold" role="region" aria-label="Threshold" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Threshold"
          description="What a model's threshold trades, and setting it: lower catches more starts and fires more often with no gesture under way. Each dot is a threshold, on the recordings the model was tested on; its own is ringed, and the dashed line is the budget a model must stay within to go live."
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <select aria-label="Model for the threshold" className="recipe-select" value={version} onChange={(event) => choose(event.target.value)}>
            <option value="">Choose a model…</option>
            {choices.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}: {modelName(entry)} ({entry.active ? "active" : entry.state}{entry.activation != null ? `, ${entry.activation.toFixed(2)}` : ""})
              </option>
            ))}
          </select>
          {model && !model.imported && (
            <Button type="button" onClick={() => void run()} disabled={!desktopAvailable || running} aria-busy={running}>
              {running ? "Working it out…" : "Show the trade-off"}
            </Button>
          )}
        </div>
        {model && current !== null && (
          <p aria-label="Current threshold">
            It runs at <strong className="font-mono">{<AnimatedNumber value={current} digits={2} />}</strong>
            {model.release != null ? <> and a detection ends below <span className="font-mono">{<AnimatedNumber value={model.release} digits={2} />}</span></> : null}.
            {last ? <>{" Changed from "}<AnimatedNumber value={last.fromActivation} digits={2} />{" to "}<AnimatedNumber value={last.toActivation} digits={2} />{" on "}{formatTime(last.at)}{"."}</> : ""}
          </p>
        )}
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        {applied && <Alert role="status"><AlertDescription>{applied}</AlertDescription></Alert>}
        {model?.imported && (
          <div className="flex flex-col gap-2">
            <p className="hint">This model was imported, so the app does not know which recordings it was tested on and cannot draw its trade-off. You can still set its threshold; check the result in Monitor or with Compare models.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="New threshold"
                className="w-28"
                type="number"
                min={0.01}
                max={1}
                step={0.01}
                placeholder={current?.toFixed(2)}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
              <Button type="button" disabled={!desktopAvailable || applying || !typedOk || typedValue === current} onClick={() => void apply(Math.round(typedValue! * 100) / 100)}>
                Use this threshold
              </Button>
            </div>
            {typed.trim() !== "" && !typedOk && <p className="field-hint text-destructive">Enter a number above 0 and at most 1.</p>}
          </div>
        )}
        {sweep && point && own && (
          <>
            <TradeOff sweeps={[sweep]} shown={shown} />
            <label className="flex flex-wrap items-center gap-2">
              Threshold
              <Button type="button" variant="outline" size="sm" aria-label="Lower the threshold one step" disabled={index <= 0} onClick={() => { setShown(points[index - 1].threshold); setConfirmOver(false); }}>−</Button>
              <input
                type="range"
                aria-label="Threshold to look at"
                aria-valuetext={point.threshold.toFixed(2)}
                min={0}
                max={points.length - 1}
                step={1}
                value={index}
                onChange={(event) => { setShown(points[Number(event.target.value)].threshold); setConfirmOver(false); }}
              />
              <Button type="button" variant="outline" size="sm" aria-label="Raise the threshold one step" disabled={index >= points.length - 1} onClick={() => { setShown(points[index + 1].threshold); setConfirmOver(false); }}>+</Button>
              <strong className="font-mono">{<AnimatedNumber value={point.threshold} digits={2} />}</strong>
            </label>
            <p role="status">
              At {<AnimatedNumber value={point.threshold} digits={2} />}: caught {<AnimatedNumber value={point.caught} />} of {<AnimatedNumber value={point.starts} />} starts ({<AnimatedNumber value={Math.round(caughtShare(point) * 100)} />}%), with {perHour(point)} false activations an hour with no gesture under way
              {withinBudget(point, sweep.budgetPerHour) ? <>{" (within the "}<AnimatedNumber value={sweep.budgetPerHour} />{" an hour budget)"}</> : <>{" (over the "}<AnimatedNumber value={sweep.budgetPerHour} />{" an hour budget)"}</>}
              {duringGestures(point) ? `; ${duringGestures(point)}` : ""}
              {point.threshold === own.threshold
                ? ". This is the model's own threshold."
                : <>{", against "}<AnimatedNumber value={Math.round(caughtShare(own) * 100)} />{"% and "}{perHour(own)}{" at its own "}<AnimatedNumber value={sweep.threshold} digits={2} />{"."}</>}
            </p>
            {point.threshold !== own.threshold && (
              <div className="flex flex-wrap items-center gap-2">
                {over && !confirmOver ? (
                  <Button type="button" variant="outline" disabled={!desktopAvailable || applying} onClick={() => setConfirmOver(true)}>
                    Use {<AnimatedNumber value={point.threshold} digits={2} />}
                  </Button>
                ) : (
                  <Button type="button" variant={over ? "destructive" : "default"} disabled={!desktopAvailable || applying} onClick={() => void apply(point.threshold)}>
                    {over ? <>{"Use "}<AnimatedNumber value={point.threshold} digits={2} />{" anyway"}</> : <>{"Use "}<AnimatedNumber value={point.threshold} digits={2} /></>}
                  </Button>
                )}
                {over && confirmOver && <small className="text-destructive">It fires more often than the budget allows with no gesture under way.</small>}
                {model?.active && <small className="text-muted-foreground">This model is active: the change applies at once.</small>}
              </div>
            )}
            {cohortNote(point) && <p className="hint" aria-label="Label timing">{cohortNote(point)}</p>}
            <p className="hint">
              Over {<AnimatedNumber value={sweep.recordings} />} test recording{sweep.recordings === 1 ? "" : "s"} ({<AnimatedNumber value={Math.round(point.negativeSeconds / 60)} />} minutes with no gesture under way), from one run of the model's scores through its detection rule at each threshold. A repeat fired again during a pinch it had caught; a late one fired during a pinch it missed. Neither is a false activation. A detection ends when the score falls as far below the threshold as it does now.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
