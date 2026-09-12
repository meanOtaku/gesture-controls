import { ChevronDownIcon } from "lucide-react";
import { useRef, type ChangeEvent } from "react";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
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
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { Input } from "../../../components/ui/input";
import { GESTURE_DATASET_LABELS, type GestureDatasetLabel } from "../../telemetry/store/telemetryStore";
import { ROLE_COPY, roleFor, type DatasetLabel, type DatasetSummary } from "../types";

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
  labels: DatasetLabel[];
  loading: boolean;
  importing: boolean;
  error: string | null;
  selectedDatasetIds: Set<string>;
  pendingDeleteIds: Set<string>;
  coverageByLabel: Map<string, number>;
  onImport: (args: { filename: string; csvContent: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToggleSelected: (id: string) => void;
};

/** Imports and manages recorded session CSVs, and shows how many sessions cover each label. */
export function DatasetManager({
  desktopAvailable,
  datasets,
  labels,
  loading,
  importing,
  error,
  selectedDatasetIds,
  pendingDeleteIds,
  coverageByLabel,
  onImport,
  onDelete,
  onToggleSelected,
}: DatasetManagerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const csvContent = await readFileAsText(file);
    await onImport({ filename: file.name, csvContent });
  };

  return (
    <>
      <Card id="lab-dataset" role="region" aria-label="Dataset" className="min-w-0">
        <CardHeader>
          <SectionHeader
            title="Dataset"
            description={
              <>
                Use the Live data tab&apos;s labeled dataset recorder to capture one CSV per session: pick a label,
                start recording, perform the gesture (or the background activity), stop, then Export Dataset CSV.
                Each exported file is one recording session, labeled uniformly for its whole duration. Check the
                sessions you want to train on below.
              </>
            }
            help={{
              label: "About importing datasets",
              content: "Only CSVs exported from the Live data tab's labeled dataset recorder are supported; each file becomes one managed, selectable training session.",
            }}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            hidden
            onChange={(event) => {
              void handleFileChange(event);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!desktopAvailable || importing}
              aria-busy={importing}
            >
              {importing ? "Importing…" : "Import dataset CSV"}
            </Button>
          </div>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {loading ? (
            <p className="hint">Loading imported sessions&hellip;</p>
          ) : datasets.length === 0 ? (
            <p className="hint">No dataset sessions imported yet. Export a CSV from the Live data tab, then import it here.</p>
          ) : (
            <div className="vectors model-lab-datasets">
              {datasets.map((dataset) => (
                <div className="vector-row model-lab-label-row" key={dataset.id}>
                  <label className="model-lab-dataset-select">
                    <input
                      type="checkbox"
                      checked={selectedDatasetIds.has(dataset.id)}
                      onChange={() => onToggleSelected(dataset.id)}
                      aria-label={`Select ${dataset.originalFilename}`}
                    />
                    <span className="label">
                      {dataset.originalFilename} &mdash; {dataset.label.replaceAll("_", " ")} ({dataset.rowCount} rows)
                    </span>
                  </label>
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={<Button type="button" variant="outline" disabled={pendingDeleteIds.has(dataset.id)}>Delete</Button>}
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this dataset session?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This permanently deletes {dataset.originalFilename} ({dataset.rowCount} rows) from the
                          desktop app. This cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep session</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => void onDelete(dataset.id)}>
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card id="lab-coverage" role="region" aria-label="Label coverage" className="min-w-0">
        <CardHeader>
          <SectionHeader
            title="Label coverage"
            description="Labels are persisted by the desktop with stable IDs. Archived labels stay visible and remain usable so historical sessions and newly imported recordings keep the same meaning."
          />
        </CardHeader>
        <CardContent>
          <Collapsible>
            <div className="flex w-full items-center justify-between gap-2">
              <CollapsibleTrigger
                render={<Button type="button" variant="ghost" className="justify-between px-0 hover:bg-transparent" />}
              >
                <span>View label coverage &middot; {coverageByLabel.size} labels recorded</span>
                <ChevronDownIcon aria-hidden="true" />
              </CollapsibleTrigger>
              <HelpTooltip label="About label coverage">
                Aim for at least 2 separate session files per label you plan to train on, since evaluation holds out
                whole sessions.
              </HelpTooltip>
            </div>
            <CollapsibleContent>
              <div className="vectors model-lab-labels">
                {GESTURE_DATASET_LABELS.map((label: GestureDatasetLabel) => {
                  const role = roleFor(label);
                  const count = coverageByLabel.get(label) ?? 0;
                  return (
                    <div className="vector-row model-lab-label-row" key={label}>
                      <span className="label">{label.replaceAll("_", " ")}</span>
                      <span className="model-lab-coverage-count">{count} session{count === 1 ? "" : "s"}</span>
                      <Badge variant={role === "positive" ? "default" : role === "hold" ? "secondary" : "outline"}>
                        {ROLE_COPY[role]}
                      </Badge>
                    </div>
                  );
                })}
                {labels.filter((label) => !GESTURE_DATASET_LABELS.some((builtin) => builtin === label.id)).map((label) => {
                  const count = coverageByLabel.get(label.id) ?? 0;
                  return (
                    <div className="vector-row model-lab-label-row" key={label.id}>
                      <span className="label">{label.displayName} <code>{label.id}</code></span>
                      <span className="model-lab-coverage-count">{count} session{count === 1 ? "" : "s"}</span>
                      <Badge variant="outline">{label.role}</Badge>
                      {label.archivedAt && <span className="hint">Archived</span>}
                    </div>
                  );
                })}
              </div>
              <p className="hint">
                Record at least 2 separate session files per label you plan to train on: evaluation is a grouped
                holdout by session (<code>GroupShuffleSplit</code> on <code>session_id</code>), so a label with only
                one session has nothing to hold out. Aim for more sessions on <code>pinch_start</code> /{" "}
                <code>pinch_release</code> and on whichever everyday-activity labels are most likely to trigger false
                activations for you.
              </p>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>
    </>
  );
}
