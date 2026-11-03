import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { formatTime, modelName, newestFirst, type LabelModel } from "../labelModels";
import { cohortNote, type Judged, type LabelTiming, perHour, TIMING_NAME } from "../detectorEvents";
import { loggedFalseRate, type SealedTestLog } from "./SealedTestCard";
import { caughtShare, falsePerHour, pointAt, seriesColor, TradeOff, type ThresholdSweep } from "./ThresholdCard";

/** Mirrors `mistakes::Comparison`. */
export interface Comparison {
  models: ThresholdSweep[];
  recordings: { id: string; name: string; minutes: number; labelTiming: LabelTiming; starts: number; caught: number[]; falseActivations: number[]; negativeSeconds: number[] }[];
  /** Each model at its own threshold over all the recordings, judged on the camera-timed ones when there are enough. */
  totals: Judged[];
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–");

/**
 * Two to four models of one label side by side, on the same recordings: ones none of them trained on, so neither has seen
 * the answers. Each recording's catches and false alarms for each, their threshold trade-offs, and their final tests.
 */
export function CompareCard({ desktopAvailable, models }: { desktopAvailable: boolean; models: LabelModel[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [finals, setFinals] = useState<SealedTestLog[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trained = newestFirst(models.filter((model) => !model.imported && model.state !== "archived"));
  const label = picked.length > 0 ? trained.find((model) => model.id === picked[0])?.label : undefined;

  const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : current.length >= 4 ? current : [...current, id]));
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const [result, log] = await Promise.all([
        invoke<Comparison>("compare_models", { versionIds: picked }),
        invoke<SealedTestLog[]>("list_sealed_tests").catch(() => []),
      ]);
      setComparison(result);
      setFinals((Array.isArray(log) ? log : []).filter((entry) => picked.includes(entry.version)));
    } catch (err) {
      setError(String(err));
      setComparison(null);
    } finally {
      setRunning(false);
    }
  };

  const compared = comparison?.models ?? [];
  const totals = comparison?.totals ?? [];
  const starts = comparison?.recordings.reduce((sum, r) => sum + r.starts, 0) ?? 0;
  const minutes = comparison?.recordings.reduce((sum, r) => sum + r.minutes, 0) ?? 0;

  return (
    <Card id="lab-compare" role="region" aria-label="Compare models" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Compare models"
          description="Two to four models of one label, on the same recordings: ones none of them trained on. Each was tested on its own recordings when it was trained, so their scores there cannot be compared; here they can."
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <ul className="flex flex-col gap-1" aria-label="Models to compare">
          {trained.map((model) => (
            <li key={model.id} className="flex items-center gap-2">
              <Checkbox
                checked={picked.includes(model.id)}
                disabled={!picked.includes(model.id) && ((label !== undefined && model.label !== label) || picked.length >= 4)}
                onCheckedChange={() => toggle(model.id)}
                aria-label={`Compare ${model.id}`}
              />
              <span>{model.label}: {model.name ? <>{modelName(model)} </> : null}<span className="font-mono">{model.id}</span> <small className="text-muted-foreground">({model.state}, {formatTime(model.createdAt)})</small></span>
            </li>
          ))}
        </ul>
        <div>
          <Button type="button" onClick={() => void run()} disabled={!desktopAvailable || running || picked.length < 2} aria-busy={running}>
            {running ? "Comparing…" : picked.length >= 2 ? `Compare ${picked.length} models` : "Compare models"}
          </Button>
        </div>
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        {comparison && (
          <section aria-label="Comparison" className="flex flex-col gap-3">
            <p className="hint">On {comparison.recordings.length} recording{comparison.recordings.length === 1 ? "" : "s"} none of them trained on, {starts} starts over {minutes.toFixed(1)} minutes, each at its own threshold. False activations are those with no gesture under way, counted an hour of that time.</p>
            <table className="compare-table">
              <thead>
                <tr>
                  <th>Recording</th>
                  <th>Starts</th>
                  {compared.map((model, i) => <th key={model.version} style={{ color: seriesColor(i) }}>{model.version}<br /><small>caught · false</small></th>)}
                </tr>
              </thead>
              <tbody>
                {comparison.recordings.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name} <small className="text-muted-foreground">({TIMING_NAME[row.labelTiming]})</small></td>
                    <td>{row.starts}</td>
                    {row.caught.map((caught, i) => {
                      const best = Math.max(...row.caught) === caught && row.caught.filter((c) => c === caught).length === 1;
                      return <td key={i} className={best ? "compare-best" : undefined}>{caught} ({pct(caught, row.starts)}) · {row.falseActivations[i]}</td>;
                    })}
                  </tr>
                ))}
                <tr className="compare-total">
                  <th>{totals[0]?.cohort === "camera" ? "Camera-timed" : "All"}</th>
                  <th>{totals[0]?.starts ?? starts}</th>
                  {totals.map((total, i) => <th key={i}>{pct(total.caught, total.starts)} · {perHour(total)}/h</th>)}
                </tr>
              </tbody>
            </table>
            {totals[0] && cohortNote(totals[0]) && <p className="hint">{cohortNote(totals[0])}</p>}
            <TradeOff sweeps={compared} />
            <ul className="flex flex-wrap gap-4" aria-label="At their own thresholds">
              {compared.map((model, i) => {
                const own = model.points.length > 0 ? pointAt(model, model.threshold) : null;
                return (
                  <li key={model.version} style={{ color: seriesColor(i) }}>
                    <strong>{model.version}</strong>: threshold {model.threshold.toFixed(2)}
                    {own ? `, ${Math.round(caughtShare(own) * 100)}% at ${Math.round(falsePerHour(own))} false an hour` : ""}
                  </li>
                );
              })}
            </ul>
            <p className="hint">
              {finals.length === 0
                ? "No final test of these models yet."
                : `Final tests: ${finals.map((entry) => `${entry.version} caught ${entry.caught} of ${entry.starts} with ${loggedFalseRate(entry)} (${entry.testedAt.slice(0, 10)})`).join("; ")}.`}
            </p>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
