import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import type { DatasetLabel } from "../model-lab/types";
import { DEFAULT_PHASE_MS, PHASE_MS_RANGE, type PhaseSpec } from "./definition";

type Props = {
  what: "closing" | "opening";
  spec: PhaseSpec | null;
  onChange: (spec: PhaseSpec | null) => void;
  labels: DatasetLabel[];
  /** Labels this stretch may not use: the gesture's other labels. */
  taken: string[];
  suggestedId: string;
  suggestedName: string;
  /** Makes a label in the catalogue; resolves to an error message, or null once it exists. */
  onCreate?: (id: string, displayName: string) => Promise<string | null>;
};

/**
 * One optional stretch around a hold, marked with a label of its own: the fingers closing before it, or opening after it.
 * It needs a label (made here in one click if it does not exist yet) and a length.
 */
export function PhaseRow({ what, spec, onChange, labels, taken, suggestedId, suggestedName, onCreate }: Props) {
  const id = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const live = labels.filter((label) => label.archivedAt === null && !taken.includes(label.id));
  const exists = labels.some((label) => label.id === suggestedId);
  const side = what === "closing" ? "before" : "after";

  const turnOn = () => onChange({ labelId: exists ? suggestedId : "", ms: DEFAULT_PHASE_MS });
  const create = async () => {
    if (!onCreate) return;
    setProblem(null);
    const failure = await onCreate(suggestedId, suggestedName);
    if (failure) return setProblem(failure);
    onChange({ labelId: suggestedId, ms: spec?.ms ?? DEFAULT_PHASE_MS });
  };

  return (
    <div className="flex flex-col gap-2" role="group" aria-label={`Mark the ${what} motion`}>
      <div className="flex items-start gap-2 text-sm">
        <Checkbox checked={spec !== null} onCheckedChange={(on) => (on === true ? turnOn() : onChange(null))} aria-label={`Mark the ${what} motion`} />
        <span><strong>Mark the {what} motion</strong> <small className="text-muted-foreground">A stretch {side} the gesture, with its own label.</small></span>
      </div>
      {spec && (
        <div className="grid items-end gap-2 sm:grid-cols-[1.5fr_.8fr_auto]">
          <div className="field">
            <div className="field-head"><Label htmlFor={`${id}-label`}>Label for the {what} motion</Label></div>
            <select id={`${id}-label`} className="recipe-select" value={spec.labelId} onChange={(event) => onChange({ ...spec, labelId: event.target.value })}>
              <option value="">Choose a label…</option>
              {live.map((label) => <option key={label.id} value={label.id}>{label.displayName}</option>)}
            </select>
          </div>
          <div className="field">
            <div className="field-head"><Label htmlFor={`${id}-ms`}>Length (ms)</Label></div>
            <Input id={`${id}-ms`} type="number" min={PHASE_MS_RANGE[0]} max={PHASE_MS_RANGE[1]} step={50} value={spec.ms} onChange={(event) => onChange({ ...spec, ms: Number(event.target.value) })} />
          </div>
          {!exists && onCreate && <Button type="button" variant="outline" onClick={() => void create()}>Create “{suggestedId}”</Button>}
        </div>
      )}
      {spec && <p className="field-hint">500 ms or more fills at least one training window. A quick pinch closes faster than that, so the stretch also includes a little rest.</p>}
      {problem && <p className="field-error" role="alert">{problem}</p>}
    </div>
  );
}
