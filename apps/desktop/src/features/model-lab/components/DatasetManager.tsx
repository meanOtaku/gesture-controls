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
import { describeGaps, recordingNumber, type DatasetSummary } from "../types";

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
};

/** Imports and manages recorded session CSVs. */
export function DatasetManager({ desktopAvailable, datasets, loading, importing, error, pendingDeleteIds, onImport, onImportFolder, onConverted, onDelete }: DatasetManagerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error} Nothing was imported or changed on disk. Fix the issue and try again.</AlertDescription>
          </Alert>
        )}
        {loading ? (
          <p className="hint">Loading recordings&hellip;</p>
        ) : datasets.length === 0 ? (
          <p className="hint">No recordings imported yet.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Imported recordings">
            {datasets.map((dataset) => (
              <li key={dataset.id} className="recipe-item">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm">{dataset.sequence ? <strong className="mr-2 font-mono" aria-label={`Recording ${dataset.sequence}`}>{recordingNumber(dataset)}</strong> : null}{dataset.originalFilename}</span>
                  <small className="text-xs text-muted-foreground">{dataset.label.replaceAll("_", " ")} · {dataset.rowCount} rows{dataset.twoFiles ? " · two files" : ""}{dataset.importedAt ? ` · imported ${dataset.importedAt.slice(0, 16).replace("T", " ")}` : ""}</small>
                  {(() => {
                    const gaps = describeGaps(dataset.gaps);
                    return gaps && <small className={gaps.warn ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{gaps.warn ? "Watch stream stalled: " : ""}{gaps.text}</small>;
                  })()}
                </div>
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
                      <AlertDialogAction variant="destructive" onClick={() => void onDelete(dataset.id)}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
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
