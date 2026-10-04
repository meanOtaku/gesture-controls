import { useRef, type ChangeEvent } from "react";
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
import type { DatasetSummary } from "../types";

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
  onDelete: (id: string) => Promise<void>;
};

/** Imports and manages recorded session CSVs. */
export function DatasetManager({ desktopAvailable, datasets, loading, importing, error, pendingDeleteIds, onImport, onDelete }: DatasetManagerProps) {
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
          description="Labelled sessions to train from. Record them on the Live data tab, export the CSV, then import it here."
          help={{
            label: "About importing recordings",
            content: "Only CSVs exported from the Live data tab's labelled dataset recorder are supported. A Quick Capture session has one label; a Timeline Capture session keeps the label of each interval and drops rows outside any interval. An import either fully succeeds or writes nothing, and a failure says exactly why so you can fix it and retry.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Input ref={fileInputRef} type="file" accept=".csv" hidden onChange={(event) => void handleFileChange(event)} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => fileInputRef.current?.click()} disabled={!desktopAvailable || importing} aria-busy={importing}>
            {importing ? "Importing…" : "Import a recording (CSV)"}
          </Button>
        </div>
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
                  <span className="text-sm">{dataset.originalFilename}</span>
                  <small className="text-xs text-muted-foreground">{dataset.label.replaceAll("_", " ")} · {dataset.rowCount} rows</small>
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
