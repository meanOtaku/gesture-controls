import { AnimatedNumber, AnimatedText } from "../../../components/app/AnimatedNumber";
import { lineOf } from "../recordingNames";
import type { DatasetSummary } from "../types";
import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { appNavigation } from "../../../shared/navigation/appNavigation";
import { negativeSpanFor } from "../../labelling/labellingModel";
import { cohortNote, describeTotals, type EventTotals, type Judged, type LabelTiming, TIMING_NAME, withinBudget } from "../detectorEvents";
import type { LabelModel } from "../labelModels";

/** Mirrors `mistakes::Mistake`. */
export interface Mistake {
  /** "false": fired with no gesture under way. "repeat" and "late": fired during a pinch it had, or had not, caught. */
  kind: "missed" | "false" | "repeat" | "late";
  atMs: number;
  peak: number;
  why: "early" | "after" | "elsewhere" | null;
  during: string | null;
}

/** Mirrors `mistakes::RecordingMistakes`. */
export type RecordingMistakes = EventTotals & { id: string; name: string; role: "test" | "train"; labelTiming: LabelTiming; minutes: number; mistakes: Mistake[] };

/** Mirrors `mistakes::MistakesReport`. */
export interface MistakesReport {
  version: string;
  label: string;
  threshold: number;
  recordings: RecordingMistakes[];
  tested: Judged;
  trained: Judged | null;
  budgetPerHour: number;
  missing: string[];
}

type Shown = "all" | "missed" | "false" | "during";

const WHY: Record<NonNullable<Mistake["why"]>, string> = {
  early: "just before a start",
  after: "just after a gesture ended",
  elsewhere: "with no gesture near",
};

const SHOWN: Record<Shown, string> = { all: "All", missed: "Missed", false: "False", during: "Repeats and late" };

const shows = (shown: Shown, mistake: Mistake) =>
  shown === "all" || (shown === "during" ? mistake.kind === "repeat" || mistake.kind === "late" : mistake.kind === shown);

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** What a mistake was, in words. */
export function describeMistake(mistake: Mistake, threshold: number): string {
  if (mistake.kind === "missed") {
    return mistake.peak >= threshold ? `Missed: reached ${mistake.peak.toFixed(2)} but not at the right time` : `Missed: reached only ${mistake.peak.toFixed(2)} of ${threshold.toFixed(2)}`;
  }
  const during = mistake.during ? `, during ${mistake.during}` : "";
  if (mistake.kind === "repeat") return `Repeat: fired again during a gesture it had caught${during}`;
  if (mistake.kind === "late") return `Late: fired during a gesture it had not caught in time${during}`;
  return `False: fired with no gesture under way${mistake.why ? `, ${WHY[mistake.why]}` : ""}${during}`;
}

/** How many false activations came during each label (or with nothing labelled), most first. */
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
export function MistakesCard({ desktopAvailable, models, datasets }: { desktopAvailable: boolean; models: LabelModel[]; datasets?: DatasetSummary[] }) {
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

  const falseCount = useMemo(() => report?.recordings.reduce((sum, r) => sum + r.falseActivations, 0) ?? 0, [report]);
  const judged = (totals: Judged, where: string) => (
    <>
      {where}, <AnimatedText>{describeTotals(totals)}</AnimatedText>
      {withinBudget(totals, report!.budgetPerHour) ? <>{" (within the "}<AnimatedNumber value={report!.budgetPerHour} />{" an hour budget)"}</> : <>{" (over the "}<AnimatedNumber value={report!.budgetPerHour} />{" an hour budget)"}</>}.
    </>
  );

  const open = (datasetId: string, mistake: Mistake) =>
    appNavigation.openInLabelling({ datasetId, atMs: mistake.atMs, select: mistake.kind === "false" ? negativeSpanFor(mistake.atMs) : undefined });

  return (
    <Card id="lab-mistakes" role="region" aria-label="Mistakes" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Mistakes"
          description="Every start a model missed, every time it fired with no gesture under way, and every time it fired again (or too late) during a gesture, on the recordings it was tested on. Open one on the Labelling page: fix a wrong label there, or label a false activation's stretch as everyday activity so the next model learns from it."
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
        {report && (
          <section aria-label="Mistakes found" className="flex flex-col gap-3 text-sm">
            <p>
              <strong>{report.label}</strong> ({report.version}, threshold {<AnimatedNumber value={report.threshold} digits={2} />}): {judged(report.tested, "on the recordings it was tested on")}
              {report.trained ? <> {judged(report.trained, "On those it trained on")}</> : null}
              {report.missing.length > 0 ? <>{" "}<AnimatedNumber value={report.missing.length} />{" of its recordings are no longer in Model Lab."}</> : ""}
            </p>
            {cohortNote(report.tested) && <p className="hint" aria-label="Label timing">{cohortNote(report.tested)}</p>}
            {falseCount > 0 && (
              <p className="hint">
                False activations came during: {falseByActivity(report).map(([during, count]) => `${during} (${count})`).join(", ")}.
              </p>
            )}
            <div className="flex gap-2" role="group" aria-label="Show">
              {(["all", "missed", "false", "during"] as const).map((kind) => (
                <Button key={kind} type="button" size="sm" variant={shown === kind ? "default" : "outline"} onClick={() => setShown(kind)}>
                  {SHOWN[kind]}
                </Button>
              ))}
            </div>
            {report.recordings.map((recording) => {
              const listed = recording.mistakes.filter((mistake) => shows(shown, mistake));
              return (
                <details key={recording.id} open={report.recordings.length <= 3}>
                  <summary>
                    {lineOf(datasets, recording.id, recording.name)} <small className="text-muted-foreground">({recording.role === "test" ? "tested on" : "trained on"}, {TIMING_NAME[recording.labelTiming]}; caught {<AnimatedNumber value={recording.caught} />} of {<AnimatedNumber value={recording.starts} />}, {<AnimatedNumber value={recording.falseActivations} />} false, {<AnimatedNumber value={recording.repeats} />} repeat{recording.repeats === 1 ? "" : "s"}, {<AnimatedNumber value={recording.late} />} late)</small>
                  </summary>
                  {listed.length === 0 ? (
                    <p className="hint">Nothing to show.</p>
                  ) : (
                    <ul className="mistake-list" aria-label={`Mistakes in ${lineOf(datasets, recording.id, recording.name)}`}>
                      {listed.map((mistake) => (
                        <li key={`${mistake.kind}-${mistake.atMs}`} className={`mistake-${mistake.kind}`}>
                          <span className="font-mono"><AnimatedText>{seconds(mistake.atMs)}</AnimatedText></span>
                          <span><AnimatedText>{describeMistake(mistake, report.threshold)}</AnimatedText></span>
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
