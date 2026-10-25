import { describeContext } from "../../telemetry/sessionContext";
import { invoke } from "@tauri-apps/api/core";
import { useRef, useState, type ChangeEvent } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../components/ui/alert-dialog";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Badge } from "../../../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { Checkbox } from "../../../components/ui/checkbox";
import { afterUndoWindow } from "../../../components/app/OperationFeedback";
import { appNavigation } from "../../../shared/navigation/appNavigation";
import { extraCopies, filterRecordings, NO_FILTER, type RecordingFilter } from "../recordingFilters";
import { LabelSwatch } from "../../labels/labelColor";
import { datasetLabels, describeGaps, describeQuality, recordingDay, recordingNumber, sameDataAs, type DatasetLabel, type DatasetSummary } from "../types";

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("failed to read dataset CSV"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
}

type DatasetManagerProps = {
  desktopAvailable: boolean;
  datasets: DatasetSummary[];
  loading: boolean;
  importing: boolean;
  error: string | null;
  pendingDeleteIds: Set<string>;
  onImport: (args: { filename: string; csvContent: string }) => Promise<void>;
  /** Chooses and imports a recording folder (`ppg.csv` and `imu.csv`). */
  onImportFolder?: () => Promise<void>;
  /** Called after recordings were converted, so the list reloads. */
  onConverted?: () => void;
  onDelete: (id: string) => Promise<void>;
  /** Seals (or unseals) recordings for the final test. */
  onSeal?: (ids: string[], sealed: boolean) => Promise<void>;
  /** The Labels list, for each label's colour. */
  labels?: DatasetLabel[];
};

/** Imports and manages recorded session CSVs. */
export function DatasetManager({ desktopAvailable, datasets, loading, importing, error, pendingDeleteIds, onImport, onImportFolder, onConverted, onDelete, onSeal, labels = [] }: DatasetManagerProps) {
  const days = [...new Set(datasets.map(recordingDay))].sort();
  const allLabels = [...new Set(datasets.flatMap(datasetLabels))].filter(Boolean).sort();
  const sealedCount = datasets.filter((dataset) => dataset.sealed).length;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [filter, setFilter] = useState<RecordingFilter>(NO_FILTER);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const shown = filterRecordings(datasets, filter).filter((dataset) => !leaving.has(dataset.id));
  // Only what is still listed counts as picked.
  const chosen = datasets.filter((dataset) => picked.has(dataset.id));
  const copies = extraCopies(datasets.filter((dataset) => !leaving.has(dataset.id)));
  const setPick = (id: string, on: boolean) =>
    setPicked((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allShownPicked = shown.length > 0 && shown.every((dataset) => picked.has(dataset.id));
  // Deleting waits a few seconds, with Undo on its message; until then the recordings are only hidden.
  const deleteAll = (ids: string[]) => {
    setLeaving((current) => new Set([...current, ...ids]));
    setPicked(new Set());
    const names = datasets.filter((dataset) => ids.includes(dataset.id)).map((dataset) => dataset.originalFilename);
    afterUndoWindow(
      ids.length === 1 ? "Deleting a recording" : `Deleting ${ids.length} recordings`,
      names.join(", "),
      () => {
        setWorking(true);
        void (async () => {
          try {
            for (const id of ids) await onDelete(id);
          } finally {
            setWorking(false);
            setLeaving((current) => new Set([...current].filter((id) => !ids.includes(id))));
          }
        })();
      },
      () => setLeaving((current) => new Set([...current].filter((id) => !ids.includes(id)))),
    );
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await onImport({ filename: file.name, csvContent: await readFileAsText(file) });
  };

  return (
    <Card id="lab-dataset" role="region" aria-label="Recordings" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Recordings"
          description="Labelled sessions to train from. Record them on the Recorder tab, export the CSV, then import it here."
          help={{
            label: "About importing recordings",
            content: "Only CSVs exported from the Recorder tab's labelled dataset recorder are supported. A Quick Capture session has one label; a Timeline Capture session keeps the label of each interval and drops rows outside any interval. An import either fully succeeds or writes nothing, and a failure says exactly why so you can fix it and retry.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Input ref={fileInputRef} type="file" accept=".csv" hidden onChange={(event) => void handleFileChange(event)} />
        <div className="flex flex-wrap items-center gap-2">
          {onImportFolder && (
            <Button type="button" onClick={() => void onImportFolder()} disabled={!desktopAvailable || importing} aria-busy={importing}>
              {importing ? "Importing…" : "Import a recording folder"}
            </Button>
          )}
          <Button type="button" variant={onImportFolder ? "outline" : "default"} onClick={() => fileInputRef.current?.click()} disabled={!desktopAvailable || importing} aria-busy={importing}>
            {onImportFolder ? "Import a single CSV (older format)" : "Import a recording (CSV)"}
          </Button>
        </div>
        <ConvertOlderRecordings datasets={datasets} onConverted={onConverted} />
        {onSeal && datasets.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Seal for the final test">
            <span>
              <strong>Final test:</strong> {sealedCount} sealed. Seal a whole day you have not trained on; it is then never trained on, and Final test below runs a model over it.
            </span>
            <Select value="" onValueChange={(day) => void onSeal(datasets.filter((dataset) => recordingDay(dataset) === day).map((dataset) => dataset.id), true)}>
              <SelectTrigger aria-label="Seal a day" className="w-44">
                <SelectValue placeholder="Seal a day…" />
              </SelectTrigger>
              <SelectContent>
                {days.map((day) => (
                  <SelectItem key={day} value={day}>
                    {day} ({datasets.filter((dataset) => recordingDay(dataset) === day).length})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error} Nothing was imported or changed on disk. Fix the issue and try again.</AlertDescription>
          </Alert>
        )}
        {copies.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Copies">
            <span className="text-destructive">
              <strong>{copies.length} cop{copies.length === 1 ? "y" : "ies"}</strong> of other recordings: they count twice in training and in every test.
            </span>
            <ConfirmButton
              label={`Keep one of each (delete ${copies.length})`}
              title="Delete the copies?"
              description={`This permanently deletes ${copies.map((copy) => `${copy.sequence ? `${recordingNumber(copy)} ` : ""}${copy.originalFilename}`).join(", ")}, keeping one of each (the sealed one, else the oldest). This cannot be undone.`}
              disabled={working}
              onConfirm={() => deleteAll(copies.map((copy) => copy.id))}
            />
          </div>
        )}
        {datasets.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Find recordings">
            <Input aria-label="Search recordings" placeholder="Search names, labels, session details" className="max-w-xs" value={filter.text} onChange={(event) => setFilter({ ...filter, text: event.target.value })} />
            <select aria-label="Day" className="recipe-select" value={filter.day} onChange={(event) => setFilter({ ...filter, day: event.target.value })}>
              <option value="">Every day</option>
              {days.map((day) => <option key={day} value={day}>{day}</option>)}
            </select>
            <select aria-label="Label" className="recipe-select" value={filter.label} onChange={(event) => setFilter({ ...filter, label: event.target.value })}>
              <option value="">Every label</option>
              {allLabels.map((label) => <option key={label} value={label}>{label.replaceAll("_", " ")}</option>)}
            </select>
            <select aria-label="Show" className="recipe-select" value={filter.show} onChange={(event) => setFilter({ ...filter, show: event.target.value as RecordingFilter["show"] })}>
              <option value="all">All</option>
              <option value="problems">With something to fix</option>
              <option value="duplicates">Copies</option>
              <option value="sealed">Sealed</option>
              <option value="unsealed">Not sealed</option>
              <option value="unreviewed">Labels not reviewed</option>
              <option value="needs_work">Labels need work</option>
            </select>
            <select aria-label="Sort" className="recipe-select" value={filter.sort} onChange={(event) => setFilter({ ...filter, sort: event.target.value as RecordingFilter["sort"] })}>
              <option value="number">By number</option>
              <option value="day">By day</option>
              <option value="name">By name</option>
              <option value="contact">Worst contact first</option>
              <option value="holds">Most holds first</option>
            </select>
            <span className="hint">{shown.length} of {datasets.length}</span>
          </div>
        )}
        {chosen.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="With the chosen recordings">
            <strong>{chosen.length} chosen</strong>
            {onSeal && <Button type="button" size="sm" variant="outline" disabled={working} onClick={() => void onSeal(chosen.map((d) => d.id), true)}>Seal</Button>}
            {onSeal && <Button type="button" size="sm" variant="outline" disabled={working} onClick={() => void onSeal(chosen.map((d) => d.id), false)}>Unseal</Button>}
            <ConfirmButton
              label="Delete"
              size="sm"
              title={`Delete ${chosen.length} recording${chosen.length === 1 ? "" : "s"}?`}
              description={`This permanently deletes ${chosen.map((d) => d.originalFilename).join(", ")} from the desktop app. This cannot be undone.`}
              disabled={working}
              onConfirm={() => deleteAll(chosen.map((d) => d.id))}
            />
            <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
          </div>
        )}
        {loading ? (
          <p className="hint">Loading recordings&hellip;</p>
        ) : datasets.length === 0 ? (
          <p className="hint">No recordings imported yet.</p>
        ) : (
          <>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={allShownPicked}
              aria-label="Choose every recording listed"
              onCheckedChange={() => setPicked(allShownPicked ? new Set() : new Set(shown.map((dataset) => dataset.id)))}
            />
            Choose every recording listed
          </label>
          <ul className="flex flex-col gap-2" aria-label="Imported recordings">
            {shown.map((dataset) => (
              <li key={dataset.id} className="recipe-item">
                <Checkbox checked={picked.has(dataset.id)} aria-label={`Choose ${dataset.originalFilename}`} onCheckedChange={(on) => setPick(dataset.id, Boolean(on))} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-sm">
                    {dataset.sequence ? <strong className="mr-2 font-mono" aria-label={`Recording ${dataset.sequence}`}>{recordingNumber(dataset)}</strong> : null}
                    {dataset.originalFilename}
                    {dataset.sealed && <Badge variant="outline" className="ml-2">Sealed for the final test</Badge>}
                    {dataset.review?.status === "reviewed" && <Badge variant="secondary" className="ml-2">Labels reviewed</Badge>}
                    {dataset.review?.status === "needs_work" && <Badge variant="destructive" className="ml-2">Labels need work</Badge>}
                  </span>
                  <small className="text-xs text-muted-foreground">{datasetLabels(dataset).map((label) => <LabelSwatch key={label} label={label} catalogue={labels} />)}{dataset.label.replaceAll("_", " ")} · {dataset.rowCount} rows{dataset.twoFiles ? " · two files" : ""}{dataset.importedAt ? ` · imported ${dataset.importedAt.slice(0, 16).replace("T", " ")}` : ""}</small>
                  {(() => {
                    const quality = describeQuality(dataset.quality);
                    return quality && <small className={quality.warn ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{quality.text}</small>;
                  })()}
                  {(() => {
                    const twins = sameDataAs(dataset, datasets);
                    return twins.length > 0 && (
                      <small className="text-xs text-destructive" role="note">
                        Same data as {twins.map((twin) => `${twin.sequence ? `${recordingNumber(twin)} ` : ""}${twin.originalFilename}`).join(", ")}: delete one, or it counts twice in training and in every test.
                      </small>
                    );
                  })()}
                  {dataset.review?.status === "needs_work" && dataset.review.note && <small className="text-xs text-destructive">To do: {dataset.review.note}</small>}
                  {dataset.context && Object.keys(dataset.context).length > 0 && (
                    <small className="text-xs text-muted-foreground">Recorded: {describeContext(dataset.context)}</small>
                  )}
                  {dataset.derivedFrom && (
                    <small className="text-xs text-muted-foreground">
                      New version of {(() => {
                        const source = datasets.find((other) => other.id === dataset.derivedFrom);
                        return source ? `${source.sequence ? `${recordingNumber(source)} ` : ""}${source.originalFilename}` : "a recording since deleted";
                      })()}, labelled by hand
                    </small>
                  )}
                  {(() => {
                    const gaps = describeGaps(dataset.gaps);
                    return gaps && <small className={gaps.warn ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{gaps.warn ? "Watch stream stalled: " : ""}{gaps.text}</small>;
                  })()}
                </div>
                <Button type="button" variant="outline" onClick={() => appNavigation.openInLabelling({ datasetId: dataset.id, atMs: 0 })}>Label</Button>
                {onSeal && (
                  <Button type="button" variant="outline" onClick={() => void onSeal([dataset.id], !dataset.sealed)}>
                    {dataset.sealed ? "Unseal" : "Seal"}
                  </Button>
                )}
                <AlertDialog>
                  <AlertDialogTrigger render={<Button type="button" variant="outline" disabled={pendingDeleteIds.has(dataset.id)}>Delete</Button>} />
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this recording?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This permanently deletes {dataset.originalFilename} ({dataset.rowCount} rows) from the desktop app. This cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => deleteAll([dataset.id])}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
          {shown.length === 0 && <p className="hint">No recording matches. <Button type="button" variant="link" className="h-auto p-0" onClick={() => setFilter(NO_FILTER)}>Show them all</Button></p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A destructive button that asks first. */
function ConfirmButton({ label, title, description, disabled, onConfirm, size }: { label: string; title: string; description: string; disabled?: boolean; onConfirm: () => void; size?: "sm" }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button type="button" size={size} variant="outline" disabled={disabled}>{label}</Button>} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep them</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** What happened to one recording when converting (see `ConversionResult` in model_lab.rs). */
interface ConversionResult {
  id: string;
  originalFilename: string;
  outcome: "converted" | "failed";
  message: string;
}

/**
 * Recordings imported before the two-file format are one file with blank cells. This offers to convert them, one at a time,
 * to a folder of two dense files; the data is the same and a model trained on a recording stays tied to it.
 */
function ConvertOlderRecordings({ datasets, onConverted }: { datasets: DatasetSummary[]; onConverted?: () => void }) {
  const older = datasets.filter((dataset) => !dataset.twoFiles);
  const [working, setWorking] = useState(false);
  const [results, setResults] = useState<ConversionResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const convert = async () => {
    setWorking(true);
    setError(null);
    try {
      const done = await invoke<ConversionResult[]>("convert_datasets_to_folders");
      setResults(Array.isArray(done) ? done : []);
      onConverted?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setWorking(false);
    }
  };

  if (older.length === 0 && results === null) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-input p-3" role="group" aria-label="Older recordings">
      {older.length > 0 && (
        <>
          <p className="text-sm">
            <strong>{older.length} recording{older.length === 1 ? " is" : "s are"} in the older single-file format</strong>, with blank cells wherever the other sensor had no sample.
            Converting writes each as two dense files (pulse and motion) holding the same samples; models trained on them stay tied to the same data.
          </p>
          <div><Button type="button" variant="outline" disabled={working} onClick={() => void convert()}>{working ? "Converting…" : "Convert to two files"}</Button></div>
        </>
      )}
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      {results !== null && results.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Conversion results">
          {results.map((result) => <li key={result.id}><code>{result.originalFilename}</code>: {result.outcome === "converted" ? "converted" : "left as it was"}. <span className="text-muted-foreground">{result.message}</span></li>)}
        </ul>
      )}
    </div>
  );
}
