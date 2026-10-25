import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import type { LabelModel } from "../labelModels";
import type { DatasetSummary } from "../types";

/** Mirrors `sealed_test::SealedTestReport`. */
export interface SealedTestReport {
  version: string;
  label: string;
  threshold: number;
  testedAt: string;
  recordings: { id: string; name: string; starts: number; caught: number; falseActivations: number; minutes: number; medianLatencyMs: number | null }[];
  starts: number;
  caught: number;
  falseActivations: number;
  minutes: number;
  earlierTests: number;
}

/** Mirrors `sealed_test::SealedTestLog`. */
export interface SealedTestLog {
  testedAt: string;
  version: string;
  label: string;
  recordings: string[];
  starts: number;
  caught: number;
  falseActivations: number;
  minutes: number;
}

const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–");
const perMinute = (count: number, minutes: number) => (minutes > 0 ? (count / minutes).toFixed(1) : "–");

/**
 * The final test: a model run over the sealed recordings exactly as the app runs it live. Nothing was trained or chosen on
 * them, so this is the honest measure of how the model does on a day it has not seen. Each test is logged; the more often
 * the sealed recordings are tested, the less untouched they are.
 */
export function SealedTestCard({ desktopAvailable, models, datasets }: { desktopAvailable: boolean; models: LabelModel[]; datasets: DatasetSummary[] }) {
  const sealed = datasets.filter((dataset) => dataset.sealed);
  const [version, setVersion] = useState("");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<SealedTestReport | null>(null);
  const [log, setLog] = useState<SealedTestLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadLog = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      const entries = await invoke<SealedTestLog[]>("list_sealed_tests");
      setLog(Array.isArray(entries) ? entries : []);
    } catch {
      setLog([]);
    }
  }, [desktopAvailable]);
  useEffect(() => void loadLog(), [loadLog]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setReport(await invoke<SealedTestReport>("test_model_on_sealed", { versionId: version }));
      await loadLog();
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  };

  const testable = models.filter((model) => model.state !== "archived");
  const usedBefore = log.filter((entry) => entry.recordings.some((id) => sealed.some((dataset) => dataset.id === id))).length;

  return (
    <Card id="lab-final-test" role="region" aria-label="Final test" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Final test"
          description="Runs a model over the sealed recordings, exactly as the app runs it live. Nothing was trained or chosen on them, so this is how the model does on a day it has not seen. Test sparingly: each look makes them a little less untouched."
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {sealed.length === 0 ? (
          <p className="hint">No recording is sealed. Under Recordings, seal a whole day you have not trained on.</p>
        ) : (
          <>
            <p className="hint">
              {sealed.length} sealed recording{sealed.length === 1 ? "" : "s"}. {usedBefore === 0 ? "Not tested yet." : `Tested ${usedBefore} time${usedBefore === 1 ? "" : "s"} before.`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={version} onValueChange={(value) => setVersion(value ?? "")}>
                <SelectTrigger aria-label="Model to test" className="min-w-64">
                  <SelectValue placeholder="Choose a model">
                    {(id: string) => {
                      const model = testable.find((entry) => entry.id === id);
                      return model ? `${model.label}: ${model.id} (${model.state})` : id;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {testable.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}: {model.id} ({model.state})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" onClick={() => void run()} disabled={!desktopAvailable || running || version === ""} aria-busy={running}>
                {running ? "Testing…" : "Run the final test"}
              </Button>
            </div>
          </>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {report && (
          <section aria-label="Final test result" className="flex flex-col gap-2 text-sm">
            <p>
              <strong>{report.label}</strong> ({report.version}, threshold {report.threshold}): caught {report.caught} of {report.starts} starts ({share(report.caught, report.starts)}), with {report.falseActivations} false activations, {perMinute(report.falseActivations, report.minutes)} a minute, over {report.minutes.toFixed(1)} minutes.
              {report.earlierTests > 0 ? ` These recordings were tested ${report.earlierTests} time${report.earlierTests === 1 ? "" : "s"} before this.` : " The first test on these recordings."}
            </p>
            <table className="text-xs">
              <thead>
                <tr><th className="text-left">Recording</th><th>Starts</th><th>Caught</th><th>False / min</th><th>Median delay</th></tr>
              </thead>
              <tbody>
                {report.recordings.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td className="text-center">{row.starts}</td>
                    <td className="text-center">{row.caught} ({share(row.caught, row.starts)})</td>
                    <td className="text-center">{perMinute(row.falseActivations, row.minutes)}</td>
                    <td className="text-center">{row.medianLatencyMs === null ? "–" : `${Math.round(row.medianLatencyMs)} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {log.length > 0 && (
          <details className="text-xs">
            <summary>All final tests ({log.length})</summary>
            <ul>
              {[...log].reverse().map((entry) => (
                <li key={`${entry.testedAt}-${entry.version}`}>
                  {entry.testedAt.replace("T", " ").slice(0, 16)}: {entry.label} {entry.version}, caught {entry.caught} of {entry.starts}, {perMinute(entry.falseActivations, entry.minutes)} false a minute, on {entry.recordings.length} recordings
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
