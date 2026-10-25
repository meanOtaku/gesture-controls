import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import type { LabelModel } from "../labelModels";
import type { SealedTestLog } from "./SealedTestCard";
import { caughtShare, falsePerMinute, pointAt, seriesColor, TradeOff, type ThresholdSweep } from "./ThresholdCard";

/** Mirrors `mistakes::Comparison`. */
export interface Comparison {
  models: ThresholdSweep[];
  recordings: { id: string; name: string; minutes: number; starts: number; caught: number[]; falseActivations: number[] }[];
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
  const trained = models.filter((model) => !model.imported && model.state !== "archived");
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
  const totals = compared.map((_, i) => ({
    caught: comparison!.recordings.reduce((sum, r) => sum + r.caught[i], 0),
    falseActivations: comparison!.recordings.reduce((sum, r) => sum + r.falseActivations[i], 0),
  }));
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
              <span>{model.label}: <span className="font-mono">{model.id}</span> <small className="text-muted-foreground">({model.state}, {model.createdAt.slice(0, 10)})</small></span>
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
            <p className="hint">On {comparison.recordings.length} recording{comparison.recordings.length === 1 ? "" : "s"} none of them trained on, {starts} starts over {minutes.toFixed(1)} minutes, each at its own threshold.</p>
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
                    <td>{row.name}</td>
                    <td>{row.starts}</td>
                    {row.caught.map((caught, i) => {
                      const best = Math.max(...row.caught) === caught && row.caught.filter((c) => c === caught).length === 1;
                      return <td key={i} className={best ? "compare-best" : undefined}>{caught} ({pct(caught, row.starts)}) · {row.falseActivations[i]}</td>;
                    })}
                  </tr>
                ))}
                <tr className="compare-total">
                  <th>All</th>
                  <th>{starts}</th>
                  {totals.map((total, i) => <th key={i}>{pct(total.caught, starts)} · {(minutes > 0 ? total.falseActivations / minutes : 0).toFixed(1)}/min</th>)}
                </tr>
              </tbody>
            </table>
            <TradeOff sweeps={compared} />
            <ul className="flex flex-wrap gap-4" aria-label="At their own thresholds">
              {compared.map((model, i) => {
                const own = model.points.length > 0 ? pointAt(model, model.threshold) : null;
                return (
                  <li key={model.version} style={{ color: seriesColor(i) }}>
                    <strong>{model.version}</strong>: threshold {model.threshold.toFixed(2)}
                    {own ? `, ${Math.round(caughtShare(own) * 100)}% at ${falsePerMinute(own).toFixed(1)} false a minute` : ""}
                  </li>
                );
              })}
            </ul>
            <p className="hint">
              {finals.length === 0
                ? "No final test of these models yet."
                : `Final tests: ${finals.map((entry) => `${entry.version} caught ${entry.caught} of ${entry.starts} with ${(entry.minutes > 0 ? entry.falseActivations / entry.minutes : 0).toFixed(1)} false a minute (${entry.testedAt.slice(0, 10)})`).join("; ")}.`}
            </p>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
