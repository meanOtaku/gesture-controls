import { useState } from "react";
import { AsyncActionButton } from "../../../components/app/AsyncActionButton";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { formatPercent, type DatasetSummary, type ReplayReport } from "../types";

const DEFAULT_MAX_OUTCOMES = 200;

type ReplayPanelProps = {
  deployableModelIds: string[];
  datasets: DatasetSummary[];
  onReplay: (params: { modelId: string; datasetIds: string[]; maxOutcomes: number }) => Promise<ReplayReport>;
};

/** Offline replay of a deployable (TFLite, approved/active) model against recorded datasets,
 * bounded to `MAX_REPLAY_OUTCOMES` outcomes per the Rust `replay_model_dataset` command. */
export function ReplayPanel({ deployableModelIds, datasets, onReplay }: ReplayPanelProps) {
  const [modelId, setModelId] = useState("");
  const [datasetIds, setDatasetIds] = useState<Set<string>>(new Set());
  const [maxOutcomes, setMaxOutcomes] = useState(DEFAULT_MAX_OUTCOMES);
  const [report, setReport] = useState<ReplayReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleDataset = (id: string) => {
    setDatasetIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const canRun = modelId !== "" && datasetIds.size > 0;

  const runReplay = async () => {
    setError(null);
    try {
      const result = await onReplay({ modelId, datasetIds: Array.from(datasetIds), maxOutcomes });
      setReport(result);
      OperationFeedback.success("Replay complete", `Matched ${result.matched_count} of ${result.window_count} windows.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      OperationFeedback.error("Replay failed", message);
    }
  };

  return (
    <Card id="lab-replay" role="region" aria-label="Replay" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Replay"
          description="Run a deployable model against recorded datasets offline to see how it would have classified each window, without touching live sensors or the active inference path."
          help={{
            label: "About replay",
            content: "Replay only accepts models with a validated LiteRT bundle in the Approved or Active lifecycle state. It shells out to the same offline pinch-classifier-replay tool used in evaluation, bounded to a fixed number of reported outcomes.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {deployableModelIds.length === 0 ? (
          <p className="hint">No deployable models yet. Approve or activate a TFLite model to enable replay.</p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="replay-model">Model</Label>
              <Select value={modelId} onValueChange={(value) => setModelId(value ?? "")}>
                <SelectTrigger id="replay-model" aria-label="Replay model">
                  <SelectValue placeholder="Select a model…" />
                </SelectTrigger>
                <SelectContent>
                  {deployableModelIds.map((id) => (
                    <SelectItem key={id} value={id}>
                      {id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <fieldset className="flex flex-col gap-1">
              <legend>Datasets</legend>
              {datasets.length === 0 ? (
                <p className="hint">No datasets imported yet.</p>
              ) : (
                datasets.map((dataset) => (
                  <label key={dataset.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={datasetIds.has(dataset.id)}
                      onChange={() => toggleDataset(dataset.id)}
                    />
                    {dataset.originalFilename} ({dataset.label})
                  </label>
                ))
              )}
            </fieldset>

            <div className="flex flex-col gap-1">
              <Label htmlFor="replay-max-outcomes">Max reported outcomes</Label>
              <Input
                id="replay-max-outcomes"
                type="number"
                min={1}
                value={maxOutcomes}
                onChange={(event) => setMaxOutcomes(Number(event.target.value) || DEFAULT_MAX_OUTCOMES)}
                className="max-w-32"
              />
            </div>

            <AsyncActionButton onPress={runReplay} pendingLabel="Replaying…" disabled={!canRun}>
              Run replay
            </AsyncActionButton>
          </>
        )}

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {report && (
          <div className="flex flex-col gap-2" aria-label="Replay results">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{formatPercent(report.accuracy)} accuracy</Badge>
              <span className="hint">
                Matched {report.matched_count} of {report.window_count} windows.
              </span>
              {report.outcomes_truncated && (
                <Badge variant="secondary">Outcomes truncated to {report.outcomes.length}</Badge>
              )}
            </div>
            <Collapsible>
              <CollapsibleTrigger render={<Button type="button" variant="ghost" className="px-0 hover:bg-transparent" />}>
                Show outcomes
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="vectors" aria-label="Replay outcomes">
                  {report.outcomes.map((outcome) => (
                    <div className="vector-row" key={outcome.index}>
                      <span className="label">{outcome.session_id}</span>
                      <span>
                        expected {outcome.expected}, predicted {outcome.predicted}
                        {outcome.matched ? " (matched)" : " (mismatch)"}
                      </span>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
