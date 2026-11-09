import { recordingTitle } from "../recordingNames";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Input } from "../../../components/ui/input";
import { CNN_DEFAULT_EPOCHS, MAX_STAGES, MAX_STAGE_EPOCHS, hasLabel, newStage, unstaged, type StageDraft } from "../training";
import { recordingNumber, type DatasetSummary } from "../types";

/**
 * The order the CNN learns in: a list of stages, each a set of the chosen recordings, trained one after another from where
 * the stage before left the model (for example pinches, then everyday noise, then pinches again). A rehearsing stage also
 * trains on every start and half the other moments of the stages before it, so it does not train away what they taught.
 * A recording may be in several stages; every chosen one must be in at least one.
 */
export function TrainingPlanEditor({ stages, onChange, chosen, datasets, target, disabled }: {
  stages: StageDraft[];
  onChange: (stages: StageDraft[]) => void;
  /** The recordings chosen above, in order: the only ones a stage can use. */
  chosen: DatasetSummary[];
  datasets: DatasetSummary[];
  target: string;
  disabled: boolean;
}) {
  const update = (key: string, change: Partial<StageDraft>) => onChange(stages.map((stage) => (stage.key === key ? { ...stage, ...change } : stage)));
  const move = (index: number, by: number) => {
    const next = [...stages];
    const [stage] = next.splice(index, 1);
    next.splice(index + by, 0, stage);
    onChange(next);
  };
  const toggle = (stage: StageDraft, id: string) =>
    update(stage.key, { datasetIds: stage.datasetIds.includes(id) ? stage.datasetIds.filter((other) => other !== id) : [...stage.datasetIds, id] });
  const pick = (stage: StageDraft, withLabel: boolean) =>
    update(stage.key, { datasetIds: [...new Set([...stage.datasetIds, ...chosen.filter((d) => hasLabel(d, target) === withLabel).map((d) => d.id)])] });
  const left = unstaged(stages, new Set(chosen.map((dataset) => dataset.id)));
  const name = (id: string) => {
    const dataset = datasets.find((entry) => entry.id === id);
    return dataset ? [recordingNumber(dataset), recordingTitle(dataset)].filter(Boolean).join(" ") : id;
  };

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3" aria-label="Training stages">
        {stages.map((stage, index) => (
          <li key={stage.key} className="flex flex-col gap-2 rounded-md border p-3 text-sm" aria-label={`Stage ${index + 1}`}>
            <div className="flex flex-wrap items-center gap-2">
              <strong className="tabular-nums">{index + 1}.</strong>
              <Input
                aria-label={`Name of stage ${index + 1}`}
                className="max-w-xs"
                maxLength={60}
                value={stage.name}
                disabled={disabled}
                placeholder={`Stage ${index + 1}`}
                onChange={(event) => update(stage.key, { name: event.target.value })}
              />
              <span className="ml-auto flex gap-1">
                <Button type="button" variant="ghost" aria-label={`Move stage ${index + 1} up`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>Up</Button>
                <Button type="button" variant="ghost" aria-label={`Move stage ${index + 1} down`} disabled={disabled || index === stages.length - 1} onClick={() => move(index, 1)}>Down</Button>
                <Button type="button" variant="ghost" aria-label={`Remove stage ${index + 1}`} disabled={disabled || stages.length === 1} onClick={() => onChange(stages.filter((other) => other.key !== stage.key))}>Remove</Button>
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              {index > 0 && (
                <span className="flex items-center gap-2">
                  <Checkbox checked={stage.rehearse} disabled={disabled} onCheckedChange={() => update(stage.key, { rehearse: !stage.rehearse })} aria-label={`Rehearse earlier stages in stage ${index + 1}`} />
                  <span>Rehearse earlier stages</span>
                </span>
              )}
              <label className="flex items-center gap-2">
                <span>Passes</span>
                <Input
                  type="number"
                  className="w-20"
                  min={1}
                  max={MAX_STAGE_EPOCHS}
                  step={1}
                  aria-label={`Passes in stage ${index + 1}`}
                  placeholder={String(CNN_DEFAULT_EPOCHS)}
                  value={stage.epochs ?? ""}
                  disabled={disabled}
                  onChange={(event) => {
                    const value = event.target.value === "" ? null : Math.round(Number(event.target.value));
                    update(stage.key, { epochs: value === null || Number.isNaN(value) ? null : Math.min(MAX_STAGE_EPOCHS, Math.max(1, value)) });
                  }}
                />
              </label>
              <span className="flex gap-1">
                <Button type="button" variant="outline" disabled={disabled} onClick={() => pick(stage, true)}>All with {target}</Button>
                <Button type="button" variant="outline" disabled={disabled} onClick={() => pick(stage, false)}>All without</Button>
              </span>
            </div>
            <ul className="flex flex-col gap-1" aria-label={`Recordings in stage ${index + 1}`}>
              {chosen.map((dataset) => (
                <li key={dataset.id} className="flex items-center gap-2">
                  <Checkbox checked={stage.datasetIds.includes(dataset.id)} disabled={disabled} onCheckedChange={() => toggle(stage, dataset.id)} aria-label={`${name(dataset.id)} in stage ${index + 1}`} />
                  <span>{name(dataset.id)}{hasLabel(dataset, target) ? <small className="text-muted-foreground"> · has {target}</small> : null}</span>
                </li>
              ))}
            </ul>
            {stage.datasetIds.length === 0 && <p className="field-hint text-destructive">This stage has no recordings yet.</p>}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={disabled || stages.length >= MAX_STAGES} onClick={() => onChange([...stages, newStage(`Stage ${stages.length + 1}`)])}>
          Add a stage
        </Button>
        {stages.length >= MAX_STAGES && <small className="text-muted-foreground">At most {MAX_STAGES} stages.</small>}
      </div>
      {left.length > 0 && (
        <p className="field-hint text-destructive" role="note">
          Not in any stage: {left.map(name).join(", ")}. Put each in a stage, or untick it in the recordings above.
        </p>
      )}
    </div>
  );
}
