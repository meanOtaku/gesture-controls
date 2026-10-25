import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { onRecordingsChanged } from "../../../shared/tauri/recordingBundle";
import type { DatasetSummary } from "../../model-lab/types";
import { coverageOf, valueTitle } from "../coverage";

/** A condition with fewer holds than this is thin: a model has hardly seen it. */
const THIN = 10;

/**
 * What the training data covers: how many holds of a label there are under each condition (wrist and arm, and what you
 * were doing, the strap and the pinch), from the session details of the recordings in Model Lab. The empty cells are what
 * to record next.
 */
export function CoverageCard() {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [label, setLabel] = useState("");
  const load = useCallback(async () => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    try {
      const sets = await invoke<DatasetSummary[]>("list_model_datasets");
      setDatasets(Array.isArray(sets) ? sets : []);
    } catch {
      setDatasets([]);
    }
  }, []);
  useEffect(() => {
    void load();
    return onRecordingsChanged(() => void load());
  }, [load]);

  const labels = useMemo(() => {
    const totals = new Map<string, number>();
    for (const dataset of datasets) for (const [name, count] of Object.entries(dataset.quality?.holds ?? {})) totals.set(name, (totals.get(name) ?? 0) + count);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, [datasets]);
  const shown = label || labels[0] || "";
  const coverage = useMemo(() => coverageOf(datasets, shown), [datasets, shown]);

  if (labels.length === 0) return null;
  const cell = (key: string, count: number) => <td key={key} className={count === 0 ? "coverage-none" : count < THIN ? "coverage-thin" : "coverage-ok"}>{count === 0 ? "none" : count}</td>;
  return (
    <Card role="region" aria-label="Coverage" className="min-w-0">
      <CardHeader>
        <CardTitle>What you have recorded</CardTitle>
        <CardDescription>
          Holds of a label in Model Lab's recordings, by the session details they were recorded with. A model only learns the
          conditions it was shown: record the empty and thin ones next.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Label to show" className="recipe-select" value={shown} onChange={(event) => setLabel(event.target.value)}>
            {labels.map((name) => <option key={name} value={name}>{name.replaceAll("_", " ")}</option>)}
          </select>
          <span className="hint">{coverage.total} holds in {coverage.recordings} recording{coverage.recordings === 1 ? "" : "s"}.</span>
        </div>
        <table className="coverage-grid" aria-label={`Holds of ${shown} by arm and wrist`}>
          <thead>
            <tr>
              <th>Arm</th>
              {coverage.wrists.map((wrist) => <th key={wrist}>{valueTitle("wrist", wrist)}</th>)}
            </tr>
          </thead>
          <tbody>
            {coverage.arms.map((arm) => (
              <tr key={arm}>
                <th>{valueTitle("arm", arm)}</th>
                {coverage.wrists.map((wrist) => cell(wrist, coverage.grid[arm][wrist]))}
              </tr>
            ))}
          </tbody>
        </table>
        {coverage.byField.map(({ field, title, counts }) => (
          <p key={field}>
            <strong>{title}:</strong>{" "}
            {counts.length === 0 ? "–" : counts.map(([value, count]) => `${valueTitle(field, value)} ${count}`).join(" · ")}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}
