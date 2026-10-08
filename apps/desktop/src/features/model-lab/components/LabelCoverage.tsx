import { PlusIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { bestState, labelIdFromName, type LabelModel } from "../labelModels";
import type { DatasetLabel } from "../types";

export interface NewLabel {
  id: string;
  displayName: string;
  description: string;
  role: DatasetLabel["role"];
}

type LabelCoverageProps = {
  labels: DatasetLabel[];
  models: LabelModel[];
  /** Recorded sessions per label id. */
  coverageByLabel: Map<string, number>;
  /** Resolves to an error message, or null once the label is created. */
  onCreate: (label: NewLabel) => Promise<string | null>;
  onSetArchived: (id: string, archived: boolean) => Promise<void>;
  /** Resolves to an error message, or null once deleted. */
  onDelete: (id: string) => Promise<string | null>;
};

/** Your labels: what each is called, how many recordings cover it, and how far along its model is. */
export function LabelCoverage({ labels, models, coverageByLabel, onCreate, onSetArchived, onDelete }: LabelCoverageProps) {
  const uid = useId();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState<DatasetLabel["role"]>("positiveGesture");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const id = labelIdFromName(name);
  const duplicate = id !== null && labels.some((label) => label.id === id);
  const problem = name.trim() === "" ? null : id === null ? "Use letters or digits in the name." : duplicate ? `A label with the id “${id}” already exists.` : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (id === null || problem !== null) return;
    setSaving(true);
    setFormError(null);
    const failure = await onCreate({ id, displayName: name.trim(), description: description.trim(), role });
    setSaving(false);
    if (failure !== null) {
      setFormError(failure);
      return;
    }
    setName("");
    setDescription("");
    setAdding(false);
  };

  const known = new Set(labels.map((label) => label.id));
  // A label that only a recording or a model refers to (not in the catalogue) is still listed, without actions.
  const stray = [...new Set([...coverageByLabel.keys(), ...models.map((model) => model.label)])].filter((labelId) => !known.has(labelId)).sort();
  const live = labels.filter((label) => label.archivedAt === null);
  const archived = labels.filter((label) => label.archivedAt !== null);
  const rows = [...live.map((label) => ({ id: label.id, name: label.displayName, description: label.description, archived: false, managed: true })), ...stray.map((labelId) => ({ id: labelId, name: labelId.replaceAll("_", " "), description: "", archived: false, managed: false })), ...(showArchived ? archived.map((label) => ({ id: label.id, name: label.displayName, description: label.description, archived: true, managed: true })) : [])];

  const act = async (work: () => Promise<string | null | void>) => {
    setListError(null);
    const failure = await work();
    if (typeof failure === "string") setListError(failure);
  };

  return (
    <Card id="lab-coverage" role="region" aria-label="Label coverage" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Labels"
          description="Name the gestures and activities you want to teach, then see their recordings and models."
          status={
            <Button type="button" variant="outline" disabled={adding} onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden="true" /> Add a label
            </Button>
          }
          help={{
            label: "About labels",
            content: "A label names one thing a model should recognise, such as snap_fingers. Create it here, then record it on the Recorder tab using the same name, and import the recording. A model is tested on whole recordings it never saw, so each label needs at least two. A label that recordings or models use can be archived but not deleted.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {adding && (
          <form className="flex flex-col gap-3" aria-label="New label" onSubmit={(event) => void submit(event)}>
            <div className="field">
              <div className="field-head"><Label htmlFor={`${uid}-name`}>Name</Label></div>
              <Input id={`${uid}-name`} value={name} maxLength={80} placeholder="e.g. Snap fingers" autoFocus onChange={(event) => setName(event.target.value)} />
              <p className={problem ? "field-error" : "field-hint"} role={problem ? "alert" : undefined}>
                {problem ?? (id ? `Its id will be ${id}. Record it on the Recorder tab under that id.` : "A short name for the gesture or activity.")}
              </p>
            </div>
            <div className="field">
              <div className="field-head"><Label htmlFor={`${uid}-kind`}>What is it?</Label></div>
              <select id={`${uid}-kind`} className="recipe-select" value={role} onChange={(event) => setRole(event.target.value as DatasetLabel["role"])}>
                <option value="positiveGesture">A gesture to detect</option>
                <option value="negativeBackground">Everyday activity (something it should not mistake for a gesture)</option>
              </select>
            </div>
            <div className="field">
              <div className="field-head"><Label htmlFor={`${uid}-description`}>Notes (optional)</Label></div>
              <Input id={`${uid}-description`} value={description} maxLength={500} placeholder="How you perform it" onChange={(event) => setDescription(event.target.value)} />
            </div>
            {formError && <p className="field-error" role="alert">{formError}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={saving || id === null || problem !== null}>Create label</Button>
              <Button type="button" variant="outline" onClick={() => { setAdding(false); setFormError(null); }}>Cancel</Button>
            </div>
          </form>
        )}
        {listError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{listError}</AlertDescription>
          </Alert>
        )}
        {rows.length === 0 ? (
          <p className="hint">No labels yet. Add one to get started: a label is a name for a gesture or activity you want the app to learn, like snap_fingers.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Labels">
            {rows.map((row) => {
              const sessions = coverageByLabel.get(row.id) ?? 0;
              const labelModels = models.filter((model) => model.label === row.id);
              const state = bestState(labelModels);
              const inUse = sessions > 0 || labelModels.length > 0;
              return (
                <li key={row.id} className="recipe-item">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm">
                      {row.name}{row.name !== row.id && <> <code>{row.id}</code></>}{" "}
                      {row.archived && <Badge variant="outline">Archived</Badge>}
                    </span>
                    <small className="text-xs text-muted-foreground">
                      {sessions} recording{sessions === 1 ? "" : "s"}
                      {sessions === 1 ? ": record at least one more so a model can be tested on a session it did not see" : ""}
                      {row.description ? ` · ${row.description}` : ""}
                    </small>
                  </div>
                  <div className="recipe-item-actions">
                    <Badge variant={state === "active" ? "default" : "secondary"}>{state === null ? "No model" : `Model: ${state}`}</Badge>
                    {row.managed && (
                      <Button type="button" variant="ghost" aria-label={`${row.archived ? "Restore" : "Archive"} ${row.id}`} onClick={() => void act(() => onSetArchived(row.id, !row.archived))}>
                        {row.archived ? "Restore" : "Archive"}
                      </Button>
                    )}
                    {row.managed && !inUse && (confirmingDelete === row.id ? (
                      <>
                        <Button type="button" variant="destructive" onClick={() => { setConfirmingDelete(null); void act(() => onDelete(row.id)); }}>Delete {row.id}</Button>
                        <Button type="button" variant="outline" onClick={() => setConfirmingDelete(null)}>Keep</Button>
                      </>
                    ) : (
                      <Button type="button" variant="ghost" aria-label={`Delete ${row.id}`} onClick={() => setConfirmingDelete(row.id)}>Delete</Button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {archived.length > 0 && (
          <Button type="button" variant="ghost" className="self-start" onClick={() => setShowArchived((value) => !value)}>
            {showArchived ? "Hide archived labels" : `Show ${archived.length} archived label${archived.length === 1 ? "" : "s"}`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
