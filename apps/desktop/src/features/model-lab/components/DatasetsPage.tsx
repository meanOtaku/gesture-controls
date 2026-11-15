import { AdvancedSection } from "../../../components/app/AdvancedSection";
import { invoke } from "@tauri-apps/api/core";
import { notifyRecordingsChanged } from "../../../shared/tauri/recordingBundle";
import { open } from "@tauri-apps/plugin-dialog";
import { lazy, Suspense, useCallback, useState } from "react";
import { feedbackWithUndo, OperationFeedback } from "../../../components/app/OperationFeedback";
import { useModelLabData } from "../hooks/useModelLabData";
import { recordingName } from "../recordingNames";
import { describeGaps, type DatasetSummary } from "../types";
import { DatasetManager } from "./DatasetManager";


/** The session viewer is large and rarely opened, so it loads only when unfolded. */
const SessionViewer = lazy(() => import("../../telemetry/components/SessionViewer").then((m) => ({ default: m.SessionViewer })));

/**
 * Datasets: every recording the app can label, train and test on, in one library. Recorder sessions join it as they are
 * saved, and files and folders recorded elsewhere are imported here. Name, group, seal, check and delete them here;
 * Labelling, Model Lab, Training history and the final test all list them by the same name.
 */
export function DatasetsPage() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const { datasets, labels, loading, error, setError, refreshDatasets } = useModelLabData(desktopAvailable);
  const [importing, setImporting] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());

  const handleImport = useCallback(
    async ({ filename, csvContent }: { filename: string; csvContent: string }) => {
      setImporting(true);
      try {
        await invoke("import_model_dataset", { filename, csvContent });
        setError(null);
        await refreshDatasets();
        notifyRecordingsChanged();
        OperationFeedback.success("Import recording", `Imported ${filename}.`);
      } catch (err) {
        setError(String(err));
        OperationFeedback.error("Import recording", String(err));
      } finally {
        setImporting(false);
      }
    },
    [refreshDatasets, setError],
  );

  const handleImportFolder = useCallback(async () => {
    const chosen = await open({ directory: true, multiple: false, title: "Choose a recording folder (it holds ppg.csv and imu.csv)" });
    if (typeof chosen !== "string") return;
    setImporting(true);
    try {
      const made = await invoke<DatasetSummary>("import_model_dataset_folder", { path: chosen });
      setError(null);
      await refreshDatasets();
      notifyRecordingsChanged();
      const gaps = describeGaps(made?.gaps);
      OperationFeedback.success("Import recording folder", `Imported ${made ? recordingName(made) : "the folder"}.${gaps?.warn ? ` The watch stream stalled in it (${gaps.text}).` : ""}`);
    } catch (err) {
      setError(String(err));
      OperationFeedback.error("Import recording folder", String(err));
    } finally {
      setImporting(false);
    }
  }, [refreshDatasets, setError]);

  const handleDelete = useCallback(
    async (id: string) => {
      setPendingDeleteIds((prev) => new Set(prev).add(id));
      try {
        await invoke("delete_model_dataset", { id });
        setError(null);
        await refreshDatasets();
        notifyRecordingsChanged();
        OperationFeedback.success("Delete recording", "Recording deleted.");
      } catch (err) {
        setError(String(err));
        OperationFeedback.error("Delete recording", String(err));
      } finally {
        setPendingDeleteIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [refreshDatasets, setError],
  );


  return (
    <main className="shell model-lab-shell">
      <header className="hero">
        <div>
          <h1>Recordings</h1>
          <p className="subtitle">
            Every recording to label, train and test on: name, group and seal them here.
          </p>
        </div>
      </header>
      {!desktopAvailable && <p className="hint">Recordings are kept by the desktop app, so they are unavailable in browser preview.</p>}
      <fieldset className="lab-workspace card-stack" disabled={!desktopAvailable} aria-label="Recordings">
        <DatasetManager
          desktopAvailable={desktopAvailable}
          labels={labels}
          datasets={datasets}
          loading={loading}
          importing={importing}
          error={error}
          pendingDeleteIds={pendingDeleteIds}
          onImport={handleImport}
          onImportFolder={handleImportFolder}
          onConverted={() => void refreshDatasets()}
          onDelete={handleDelete}
          onSeal={async (ids, sealed) => {
            const seal = async (which: boolean) => {
              await invoke("set_datasets_sealed", { ids, sealed: which });
              await refreshDatasets();
            };
            try {
              await seal(sealed);
              feedbackWithUndo(
                sealed ? "Sealed for the final test" : "Unsealed",
                `${ids.length} recording${ids.length === 1 ? "" : "s"}.`,
                () => void seal(!sealed).catch((err) => setError(String(err))),
              );
            } catch (err) {
              setError(String(err));
            }
          }}
          onGroup={async (ids, group) => {
            // Undo puts each back in the group it was in.
            const before = new Map<string | null, string[]>();
            for (const dataset of datasets.filter((d) => ids.includes(d.id))) {
              const was = dataset.group ?? null;
              before.set(was, [...(before.get(was) ?? []), dataset.id]);
            }
            try {
              await invoke("set_datasets_group", { ids, group });
              await refreshDatasets();
              feedbackWithUndo(
                group === null ? "Taken out of the group" : `Moved to ${group}`,
                `${ids.length} recording${ids.length === 1 ? "" : "s"}.`,
                () =>
                  void (async () => {
                    for (const [was, wasIds] of before) await invoke("set_datasets_group", { ids: wasIds, group: was });
                    await refreshDatasets();
                  })().catch((err) => setError(String(err))),
              );
            } catch (err) {
              setError(String(err));
            }
          }}
          onRename={async (id, name) => {
            const was = datasets.find((d) => d.id === id)?.name ?? null;
            try {
              await invoke("set_dataset_name", { id, name });
              await refreshDatasets();
              feedbackWithUndo(name === null ? "Name taken away" : `Renamed to ${name}`, "", () =>
                void invoke("set_dataset_name", { id, name: was }).then(refreshDatasets).catch((err) => setError(String(err))),
              );
            } catch (err) {
              setError(String(err));
            }
          }}
        />
      </fieldset>
      {desktopAvailable && (
        <AdvancedSection storageKey="recordingsLookInside" title="Look inside a session" summary="A saved session's signals as images, and the camera's label proposals">
          <Suspense fallback={<p className="hint">Loading…</p>}>
            <SessionViewer />
          </Suspense>
        </AdvancedSection>
      )}
    </main>
  );
}
