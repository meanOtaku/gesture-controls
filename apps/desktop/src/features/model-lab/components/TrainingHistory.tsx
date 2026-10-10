import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { DatasetLabel } from "../types";

/** Mirrors `TrainingHistoryProject` in label_runtime.rs. */
export interface TrainingHistoryProject {
  id: string;
  label: string;
  name: string;
  createdAt: string;
  runs: { id: string; status: string; outcome: string | null; queuedAt: string; finishedAt: string | null; failure: string | null }[];
  snapshots: number;
  models: number;
  mentions: string[];
  mentionedBy: string[];
}

type Props = {
  desktopAvailable: boolean;
  labels: DatasetLabel[];
  /** Changes whenever the models do, so the list reloads. */
  refreshKey: string;
};

const OUTCOMES: Record<string, string> = { deployable: "ready to use", evaluationOnly: "scored only", failed: "failed" };
const day = (iso: string) => iso.slice(0, 10);

/** Why a project's history cannot be deleted right now, in words, or null. */
export function deleteBlocker(project: Pick<TrainingHistoryProject, "label" | "models" | "mentionedBy">): string | null {
  if (project.models > 0) return `It still has ${project.models} model${project.models === 1 ? "" : "s"}. Delete them under Label models first.`;
  if (project.mentionedBy.length > 0) return `The training history of ${project.mentionedBy.join(", ")} mentions this label, and that history is sealed. Delete that history first.`;
  return null;
}

/**
 * What the model registry remembers of each label's training: the project, every run and the snapshots sealed for it.
 * A deleted model leaves this behind as the record of what was tried. Deleting it removes the record, never a recording.
 */
export function TrainingHistory({ desktopAvailable, labels, refreshKey }: Props) {
  const [projects, setProjects] = useState<TrainingHistoryProject[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      const list = await invoke<TrainingHistoryProject[]>("list_training_history");
      setProjects(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(String(err));
    }
  }, [desktopAvailable]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const nameOf = (id: string) => labels.find((label) => label.id === id)?.displayName ?? id.replaceAll("_", " ");

  const remove = async (project: TrainingHistoryProject) => {
    setBusy(true);
    setError(null);
    try {
      await invoke("delete_label_history", { label: project.label });
      OperationFeedback.success("Delete training history", `Deleted the training history of ${nameOf(project.label)}.`);
      setConfirming(null);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="lab-history" role="region" aria-label="Training history" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Training history"
          description="What was tried for each label. Kept after a model is deleted."
          help={{
            label: "About training history",
            content: "Each time you train a model, the app records a project for its label, every run with how it ended, and the sealed snapshot of exactly which recordings it used. Deleting a model leaves this record behind. It is safe to delete once the label has no models. It never touches your recordings. A label cannot be deleted while its history exists, and one label's history can mention another (as 'not the gesture'), which stops that other label being deleted until this history is gone.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        {projects.length === 0 ? (
          <p className="hint">Nothing yet. A label gets a record here the first time you train a model for it.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Training history by label">
            {projects.map((project) => {
              const blocker = deleteBlocker(project);
              const latest = project.runs[0];
              return (
                <li key={project.id} className="recipe-item">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm">
                      {nameOf(project.label)} <code>{project.label}</code>{" "}
                      <Badge variant={project.models > 0 ? "default" : "secondary"}>{project.models} model{project.models === 1 ? "" : "s"}</Badge>
                    </span>
                    <small className="text-xs text-muted-foreground">
                      {project.runs.length} run{project.runs.length === 1 ? "" : "s"} · {project.snapshots} sealed snapshot{project.snapshots === 1 ? "" : "s"}
                      {latest ? ` · latest ${day(latest.queuedAt)}: ${latest.outcome ? OUTCOMES[latest.outcome] ?? latest.outcome : latest.status}` : ""}
                    </small>
                    {(project.mentions.length > 0 || project.mentionedBy.length > 0) && (
                      <small className="text-xs text-muted-foreground">
                        {project.mentions.length > 0 ? `Trained against: ${project.mentions.map(nameOf).join(", ")}. ` : ""}
                        {project.mentionedBy.length > 0 ? `Mentioned in the history of: ${project.mentionedBy.map(nameOf).join(", ")}.` : ""}
                      </small>
                    )}
                    {project.runs.length > 0 && (
                      <details className="text-xs">
                        <summary className="cursor-pointer">Runs</summary>
                        <ul aria-label={`Runs for ${project.label}`} className="mt-1 flex flex-col gap-1">
                          {project.runs.map((run) => (
                            <li key={run.id}>{day(run.queuedAt)} · {run.outcome ? OUTCOMES[run.outcome] ?? run.outcome : run.status}{run.failure ? `: ${run.failure}` : ""}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                  <div className="recipe-item-actions">
                    {confirming === project.id ? (
                      <>
                        <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove(project)}>Delete history of {project.label}</Button>
                        <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(null)}>Keep</Button>
                      </>
                    ) : (
                      <Button type="button" variant="outline" disabled={blocker !== null} title={blocker ?? "Delete this label's training history"} aria-label={`Delete training history of ${project.label}`} onClick={() => setConfirming(project.id)}>
                        Delete history
                      </Button>
                    )}
                  </div>
                  {blocker && <small className="text-xs text-muted-foreground w-full">{blocker}</small>}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
