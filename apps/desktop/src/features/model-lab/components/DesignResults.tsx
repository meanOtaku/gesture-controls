import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { BarChart } from "../../../components/charts/BarChart";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { groupByDesign, type DesignResult } from "../designResults";

const fixed = (value: number | null, digits = 2) => (value === null ? "–" : value.toFixed(digits));
const percent = (value: number | null) => (value === null ? "–" : `${Math.round(value * 100)}%`);
const short = (name: string) => (name.length > 14 ? `${name.slice(0, 13)}…` : name);

/**
 * Which network design worked best: the models trained here grouped by the design they came from, with their scores on
 * recordings they never trained on. Few models make for weak evidence, and the page says so.
 */
export function DesignResults({ desktopAvailable, refreshKey, onInspect }: { desktopAvailable: boolean; refreshKey: string; onInspect: (id: string) => void }) {
  const [results, setResults] = useState<DesignResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktopAvailable) return;
    let stale = false;
    void invoke<DesignResult[]>("list_design_results")
      .then((list) => { if (!stale) setResults(Array.isArray(list) ? list : []); })
      .catch((err) => { if (!stale) setError(String(err)); });
    return () => { stale = true; };
  }, [desktopAvailable, refreshKey]);

  const groups = useMemo(() => groupByDesign(results), [results]);
  const charted = groups.filter((g) => g.meanAuc !== null);

  return (
    <Card id="lab-results" role="region" aria-label="Results by design" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Results by design"
          description="How each network design did on recordings its models never trained on."
          help={{ label: "About results by design", content: "Every model trained here is grouped under the design it was trained with. The score is AUC on held-out recordings, where 0.5 is chance and 1 is perfect, averaged over the models of a design that were trained from scratch (models made by editing or fine-tuning another model are listed but not averaged). A design with one or two models, or models for different labels, is weak evidence: the table says how many scores each average rests on." }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        {groups.length === 0 ? (
          <p className="hint">No models trained here yet. Train one in Model Lab with a design and it appears here.</p>
        ) : (
          <>
            {charted.length > 0 && (
              <BarChart
                title="Average held-out score by design" exportName="results-by-design" xLabel="Design" yLabel="AUC"
                bins={charted.map((g) => short(g.name))}
                series={[{ name: "Average AUC", color: "#3b82f6", values: charted.map((g) => Math.round((g.meanAuc ?? 0) * 100) / 100) }]}
                summary={charted.map((g) => `${g.name}: ${fixed(g.meanAuc)} from ${g.scored} model${g.scored === 1 ? "" : "s"}`).join("; ") + "."}
              />
            )}
            <div className="max-w-full overflow-auto">
              <table className="w-full text-sm" aria-label="Designs compared">
                <thead>
                  <tr className="text-left">
                    <th scope="col">Design</th><th scope="col">Models</th><th scope="col">Scored</th><th scope="col">Average AUC</th><th scope="col">Best AUC</th><th scope="col">Average F1</th><th scope="col">Average false alarms</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <tr key={group.key}>
                      <th scope="row" className="text-left font-semibold">{group.name}{group.note && <small className="block font-normal text-muted-foreground">{group.note}</small>}</th>
                      <td>{group.models.length}</td>
                      <td>{group.scored}</td>
                      <td>{fixed(group.meanAuc)}</td>
                      <td>{fixed(group.bestAuc)}</td>
                      <td>{fixed(group.meanF1)}</td>
                      <td>{percent(group.meanFalseActivation)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {groups.some((g) => g.scored === 1) && <p className="field-hint">An average of one score is just that score: train the design on more labels or sessions before trusting a comparison.</p>}
            <ul className="flex flex-col gap-3" aria-label="Models by design">
              {groups.map((group) => (
                <li key={group.key} className="flex flex-col gap-1">
                  <strong className="text-sm">{group.name}</strong>
                  <ul className="flex flex-col gap-1" aria-label={`Models of ${group.name}`}>
                    {group.models.map((model) => (
                      <li key={model.modelId} className="flex flex-wrap items-center gap-3 text-sm">
                        <code>{model.modelId}</code>
                        <span>{model.label}</span>
                        <span className="text-muted-foreground">{model.metrics?.rocAuc === undefined ? "no score kept" : `AUC ${fixed(model.metrics.rocAuc)}, F1 ${fixed(model.metrics.f1 ?? null)}`}{model.edited ? " · edited or fine-tuned" : ""}</span>
                        <Button type="button" size="sm" variant="ghost" aria-label={`Look inside ${model.modelId} from results`} onClick={() => onInspect(model.modelId)}>Look inside</Button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
