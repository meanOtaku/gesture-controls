import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { appNavigation } from "../../../shared/navigation/appNavigation";
import { negativeSpanFor } from "../../labelling/labellingModel";
import type { LabelModel } from "../labelModels";

/** Mirrors `mistakes::Mistake`. */
export interface Mistake {
  kind: "missed" | "false";
  atMs: number;
  peak: number;
  why: "early" | "late" | "repeat" | "elsewhere" | null;
  during: string | null;
}

/** Mirrors `mistakes::MistakesReport`. */
export interface MistakesReport {
  version: string;
  label: string;
  threshold: number;
  recordings: { id: string; name: string; role: "test" | "train"; minutes: number; starts: number; caught: number; mistakes: Mistake[] }[];
  missing: string[];
}

type Shown = "all" | "missed" | "false";

const WHY: Record<NonNullable<Mistake["why"]>, string> = {
  early: "too early for a start",
  late: "too late for a start",
  repeat: "again, for a start already caught",
  elsewhere: "nowhere near a start",
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** What a mistake was, in words. */
export function describeMistake(mistake: Mistake, threshold: number): string {
  if (mistake.kind === "missed") {
    return mistake.peak >= threshold ? `Missed: reached ${mistake.peak.toFixed(2)} but not at the right time` : `Missed: reached only ${mistake.peak.toFixed(2)} of ${threshold.toFixed(2)}`;
  }
  return `False: fired ${mistake.why ? WHY[mistake.why] : ""}${mistake.during ? `, during ${mistake.during}` : ""}`;
}

/** How many false detections came during each label (or with nothing labelled), most first. */
export function falseByActivity(report: MistakesReport): [string, number][] {
  const counts = new Map<string, number>();
  for (const recording of report.recordings) {
    for (const mistake of recording.mistakes) {
      if (mistake.kind !== "false") continue;
      const key = mistake.during ?? "nothing labelled";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Every mistake a model makes, one by one: the starts it missed and the times it fired when it should not, on the
 * recordings it was tested on. Open one to see it on the Labelling page: a wrong label is fixed there, and a false
 * detection is a stretch ready to label as everyday activity, so the next model learns from it.
 */
export function MistakesCard({ desktopAvailable, models }: { desktopAvailable: boolean; models: LabelModel[] }) {
  const [version, setVersion] = useState("");
  const [includeTraining, setIncludeTraining] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<MistakesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown>("all");
  const trained = models.filter((model) => !model.imported && model.state !== "archived");

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setReport(await invoke<MistakesReport>("model_mistakes", { versionId: version, includeTraining }));
    } catch (err) {
      setError(String(err));
      setReport(null);
    } finally {
      setRunning(false);
    }
  };

  const totals = useMemo(() => {
    if (!report) return null;
    const all = report.recordings.flatMap((recording) => recording.mistakes);
    return {
      starts: report.recordings.reduce((sum, r) => sum + r.starts, 0),
      caught: report.recordings.reduce((sum, r) => sum + r.caught, 0),
      missed: all.filter((m) => m.kind === "missed").length,
      false: all.filter((m) => m.kind === "false").length,
      minutes: report.recordings.reduce((sum, r) => sum + r.minutes, 0),
    };
  }, [report]);

  const open = (datasetId: string, mistake: Mistake) =>
    appNavigation.openInLabelling({ datasetId, atMs: mistake.atMs, select: mistake.kind === "false" ? negativeSpanFor(mistake.atMs) : undefined });

  return (
    <Card id="lab-mistakes" role="region" aria-label="Mistakes" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Mistakes"
          description="Every start a model missed and every time it fired when it should not, on the recordings it was tested on. Open one on the Labelling page: fix a wrong label there, or label a false detection's stretch as everyday activity so the next model learns from it."
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <select aria-label="Model" className="recipe-select" value={version} onChange={(event) => setVersion(event.target.value)}>
            <option value="">Choose a model…</option>
            {trained.map((model) => <option key={model.id} value={model.id}>{model.label}: {model.id} ({model.state})</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={includeTraining} onCheckedChange={() => setIncludeTraining((value) => !value)} aria-label="Also the recordings it trained on" />
            Also the recordings it trained on
          </label>
          <Button type="button" onClick={() => void run()} disabled={!desktopAvailable || running || version === ""} aria-busy={running}>
            {running ? "Looking…" : "Find mistakes"}
          </Button>
        </div>
        {includeTraining && <p className="field-hint">A model should do well on what it trained on: a mistake there usually means a wrong label.</p>}
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        {report && totals && (
          <section aria-label="Mistakes found" className="flex flex-col gap-3 text-sm">
            <p>
              <strong>{report.label}</strong> ({report.version}, threshold {report.threshold.toFixed(2)}): caught {totals.caught} of {totals.starts} starts; {totals.missed} missed and {totals.false} false over {totals.minutes.toFixed(1)} minutes.
              {report.missing.length > 0 ? ` ${report.missing.length} of its recordings are no longer in Model Lab.` : ""}
            </p>
            {totals.false > 0 && (
              <p className="hint">
                False detections came during: {falseByActivity(report).map(([during, count]) => `${during} (${count})`).join(", ")}.
              </p>
            )}
            <div className="flex gap-2" role="group" aria-label="Show">
              {(["all", "missed", "false"] as const).map((kind) => (
                <Button key={kind} type="button" size="sm" variant={shown === kind ? "default" : "outline"} onClick={() => setShown(kind)}>
                  {kind === "all" ? "All" : kind === "missed" ? "Missed" : "False"}
                </Button>
              ))}
            </div>
            {report.recordings.map((recording) => {
              const listed = recording.mistakes.filter((mistake) => shown === "all" || mistake.kind === shown);
              return (
                <details key={recording.id} open={report.recordings.length <= 3}>
                  <summary>
                    {recording.name} <small className="text-muted-foreground">({recording.role === "test" ? "tested on" : "trained on"}; caught {recording.caught} of {recording.starts}, {recording.mistakes.filter((m) => m.kind === "false").length} false)</small>
                  </summary>
                  {listed.length === 0 ? (
                    <p className="hint">Nothing to show.</p>
                  ) : (
                    <ul className="mistake-list" aria-label={`Mistakes in ${recording.name}`}>
                      {listed.map((mistake) => (
                        <li key={`${mistake.kind}-${mistake.atMs}`} className={`mistake-${mistake.kind}`}>
                          <span className="font-mono">{seconds(mistake.atMs)}</span>
                          <span>{describeMistake(mistake, report.threshold)}</span>
                          <Button type="button" size="sm" variant="outline" onClick={() => open(recording.id, mistake)}>Open</Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              );
            })}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
