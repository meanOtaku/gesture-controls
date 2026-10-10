import { PlusIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { CascadePanel } from "../../labels/CascadePanel";
import type { CascadeMode, CascadePlan, CascadeResult } from "../../labels/labelCascade";
import { usageCount, type LabelUsage } from "../../labels/labelUsage";
import { labelIdFromName, type LabelModel } from "../labelModels";
import type { DatasetLabel } from "../types";

/** The tabs a label's uses live in. */
export type UsageTab = "recordings" | "gestureLibrary" | "modelLab" | "recipes";

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
  /** Changes a label's name, notes and role (never its id). Resolves to an error message, or null once saved. */
  onUpdate?: (label: NewLabel) => Promise<string | null>;
  /** Saved gestures linked to each label id. */
  gestureCountByLabel?: Map<string, number>;
  /** Saved Recorder recordings that have an interval with each label id. */
  recorderCountByLabel?: Map<string, number>;
  /** Everything that uses a label, for the "Where it is used" list. */
  usageFor?: (id: string) => LabelUsage;
  /** Works out what archiving, deleting or restoring a label, with everything that uses it, would do. */
  planFor?: (mode: CascadeMode, id: string) => CascadePlan;
  onRunPlan?: (plan: CascadePlan, onProgress: (done: number, total: number) => void) => Promise<CascadeResult>;
  /** Jumps to the tab where an item of that kind lives. */
  onOpenTab?: (tab: UsageTab) => void;
  /** Resolves to an error message, or null once deleted. */
  onDelete: (id: string) => Promise<string | null>;
};

/** Your labels: what each is called, how many recordings cover it, and how far along its model is. */
export function LabelCoverage({ labels, models, coverageByLabel, onCreate, onSetArchived, onUpdate, gestureCountByLabel, recorderCountByLabel, usageFor, planFor, onRunPlan, onOpenTab, onDelete }: LabelCoverageProps) {
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
  const [editing, setEditing] = useState<NewLabel | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [cascade, setCascade] = useState<CascadePlan | null>(null);
  const openCascade = (mode: CascadeMode, id: string) => planFor && setCascade(planFor(mode, id));

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !onUpdate || editing.displayName.trim() === "") return;
    setSaving(true);
    const failure = await onUpdate({ ...editing, displayName: editing.displayName.trim(), description: editing.description.trim() });
    setSaving(false);
    if (failure !== null) return setEditError(failure);
    setEditing(null);
    setEditError(null);
  };

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
          description="Name the gestures and activities the app should know, and see where each is used."
          status={
            <Button type="button" variant="outline" disabled={adding} onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden="true" /> Add a label
            </Button>
          }
          help={{
            label: "About labels",
            content: "A label names one thing the app should recognise, such as snap_fingers. Make it here, then define its gesture in the Gesture library, record it in the Recorder, and train it in Model Lab. Each label shows how many recordings, gestures and models use it. A label something still uses can be archived but not deleted.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {adding && (
          <form className="flex flex-col gap-3" aria-label="New label" onSubmit={(event) => void submit(event)}>
            <div className="field">
              <div className="field-head"><Label htmlFor={`${uid}-name`} required>Name</Label></div>
              <Input id={`${uid}-name`} required aria-required="true" value={name} maxLength={80} placeholder="e.g. Snap fingers" autoFocus onChange={(event) => setName(event.target.value)} />
              <p className={problem ? "field-error" : "field-hint"} role={problem ? "alert" : undefined}>
                {problem ?? (id ? `Its id will be ${id}. Record it on the Recorder tab under that id.` : "A short name for the gesture or activity.")}
              </p>
            </div>
            <div className="field">
              <div className="field-head"><Label htmlFor={`${uid}-kind`} required>What is it?</Label></div>
              <select id={`${uid}-kind`} className="recipe-select" value={role} onChange={(event) => setRole(event.target.value as DatasetLabel["role"])}>
                <option value="positiveGesture">A gesture to detect</option>
                <option value="negativeBackground">Everyday activity (something it should not mistake for a gesture)</option>
              </select>
            </div>
            <div className="field">
              <div className="field-head"><Label htmlFor={`${uid}-description`}>Notes (optional)</Label></div>
              <Input id={`${uid}-description`} value={description} maxLength={500} placeholder="How you perform it" onChange={(event) => setDescription(event.target.value)} />
            </div>
            <p className="required-note"><span aria-hidden="true">*</span> Required</p>
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
        {cascade && onRunPlan && <CascadePanel key={`${cascade.mode}-${cascade.label}`} plan={cascade} onCancel={() => setCascade(null)} onRun={onRunPlan} />}
        {editing && (
          <form className="flex flex-col gap-3" aria-label={`Edit ${editing.id}`} onSubmit={(event) => void saveEdit(event)}>
            <div className="field">
              <div className="field-head"><Label htmlFor={`${uid}-edit-name`} required>Name</Label></div>
              <Input id={`${uid}-edit-name`} required aria-required="true" value={editing.displayName} maxLength={80} autoFocus onChange={(event) => setEditing({ ...editing, displayName: event.target.value })} />
              <p className="field-hint">Its id, <code>{editing.id}</code>, stays the same, so recordings, models, recipes and gestures keep pointing at it.</p>
            </div>
            <div className="field">
              <div className="field-head"><Label htmlFor={`${uid}-edit-kind`} required>What is it?</Label></div>
              <select id={`${uid}-edit-kind`} className="recipe-select" value={editing.role} onChange={(event) => setEditing({ ...editing, role: event.target.value as DatasetLabel["role"] })}>
                <option value="positiveGesture">A gesture to detect</option>
                <option value="negativeBackground">Everyday activity (something it should not mistake for a gesture)</option>
                {editing.role === "calibrationOnly" && <option value="calibrationOnly">Calibration only</option>}
              </select>
            </div>
            <div className="field">
              <div className="field-head"><Label htmlFor={`${uid}-edit-notes`}>Notes (optional)</Label></div>
              <Input id={`${uid}-edit-notes`} value={editing.description} maxLength={500} onChange={(event) => setEditing({ ...editing, description: event.target.value })} />
            </div>
            <p className="required-note"><span aria-hidden="true">*</span> Required</p>
            {editError && <p className="field-error" role="alert">{editError}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={saving || editing.displayName.trim() === ""}>Save changes</Button>
              <Button type="button" variant="outline" onClick={() => { setEditing(null); setEditError(null); }}>Cancel</Button>
            </div>
          </form>
        )}
        {rows.length === 0 ? (
          <p className="hint">No labels yet. Add one to get started: a label is a name for a gesture or activity you want the app to learn, like snap_fingers.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Labels">
            {rows.map((row) => {
              const sessions = coverageByLabel.get(row.id) ?? 0;
              const labelModels = models.filter((model) => model.label === row.id);
              const recorderRecordings = recorderCountByLabel?.get(row.id) ?? 0;
              const gestures = gestureCountByLabel?.get(row.id) ?? 0;
              const inUse = sessions > 0 || labelModels.length > 0 || gestures > 0 || (usageFor ? usageCount(usageFor(row.id)) > 0 : false);
              const full = labels.find((label) => label.id === row.id);
              return (
                <li key={row.id} className="recipe-item">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm">
                      {row.name}{row.name !== row.id && <> <code>{row.id}</code></>}{" "}
                      {row.archived && <Badge variant="outline">Archived</Badge>}
                    </span>
                    <small className="text-xs text-muted-foreground">
                      {recorderCountByLabel ? `${recorderRecordings} in Recorder recordings · ` : ""}
                      {sessions} in the training data
                      {gestureCountByLabel ? ` · ${gestures} gesture${gestures === 1 ? "" : "s"}` : ""}
                      {labelModels.length > 0 ? ` · ${labelModels.length} model${labelModels.length === 1 ? "" : "s"}` : ""}
                      {row.description ? ` · ${row.description}` : ""}
                    </small>
                    {usageFor && usageCount(usageFor(row.id)) > 0 && <UsageList usage={usageFor(row.id)} onOpenTab={onOpenTab} label={row.id} />}
                  </div>
                  <div className="recipe-item-actions">
                    {row.managed && onUpdate && full && (
                      <Button type="button" variant="ghost" aria-label={`Edit ${row.id}`} onClick={() => { setEditError(null); setEditing({ id: full.id, displayName: full.displayName, description: full.description, role: full.role }); }}>Edit</Button>
                    )}
                    {row.managed && (
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label={`${row.archived ? "Restore" : "Archive"} ${row.id}`}
                        onClick={() => {
                          const log = full?.archiveLog;
                          const logged = log && (log.disabledRecipes.length > 0 || log.archivedModels.length > 0);
                          if (planFor && onRunPlan && !row.archived && inUse) return openCascade("archive", row.id);
                          if (planFor && onRunPlan && row.archived && logged) return openCascade("restore", row.id);
                          void act(() => onSetArchived(row.id, !row.archived));
                        }}
                      >
                        {row.archived ? "Restore" : "Archive"}{planFor && onRunPlan && !row.archived && inUse ? "…" : ""}
                      </Button>
                    )}
                    {row.managed && planFor && onRunPlan && (
                      <Button type="button" variant="ghost" aria-label={`Delete ${row.id}`} onClick={() => openCascade("delete", row.id)}>Delete…</Button>
                    )}
                    {row.managed && !(planFor && onRunPlan) && !inUse && (confirmingDelete === row.id ? (
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

const GROUPS: { key: "recordings" | "trainingRecordings" | "gestures" | "models" | "recipes"; title: string; tab: UsageTab; open: string }[] = [
  { key: "gestures", title: "Gesture library", tab: "gestureLibrary", open: "Open Gesture library" },
  { key: "recordings", title: "Recorder recordings", tab: "recordings", open: "Open Recordings" },
  { key: "trainingRecordings", title: "Training data", tab: "modelLab", open: "Open Model Lab" },
  { key: "models", title: "Models", tab: "modelLab", open: "Open Model Lab" },
  { key: "recipes", title: "Recipes", tab: "recipes", open: "Open Recipes" },
];

/** A line about the training history the model registry keeps for a label, which no tab lists on its own. */
function historyText(usage: LabelUsage): string[] {
  const parts: string[] = [];
  const { projects, runs } = usage.trainingHistory;
  if (projects > 0) parts.push(`Training history: ${projects} project${projects === 1 ? "" : "s"}, ${runs} run${runs === 1 ? "" : "s"} (kept after a model is deleted)`);
  if (usage.mentionedInTrainingOf.length > 0) parts.push(`Mentioned in the training history of: ${usage.mentionedInTrainingOf.join(", ")}`);
  return parts;
}

/** Every place one label is used, by tab, each with a way to go there. */
function UsageList({ usage, label, onOpenTab }: { usage: LabelUsage; label: string; onOpenTab?: (tab: UsageTab) => void }) {
  const itemName = (item: unknown): string => {
    const entry = item as { name?: string; state?: string; id: string };
    return entry.name ?? (entry.state ? `${entry.id.slice(0, 8)} (${entry.state})` : entry.id.slice(0, 8));
  };
  return (
    <details className="text-xs">
      <summary className="cursor-pointer">Where {label} is used</summary>
      <ul className="mt-1 flex flex-col gap-1" aria-label={`Where ${label} is used`}>
        {historyText(usage).map((line) => <li key={line}>{line}</li>)}
        {GROUPS.filter((group) => (usage[group.key] as unknown[]).length > 0).map((group) => (
          <li key={group.key} className="flex flex-wrap items-center gap-2">
            <span><strong>{group.title}:</strong> {usage[group.key].map(itemName).join(", ")}</span>
            {onOpenTab && <Button type="button" variant="ghost" size="sm" onClick={() => onOpenTab(group.tab)}>{group.open}</Button>}
          </li>
        ))}
      </ul>
    </details>
  );
}
