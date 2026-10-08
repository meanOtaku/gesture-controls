import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { SectionHeader } from "../../components/app/SectionHeader";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import { LABEL_DETECTIONS_EVENT, type DetectionReport, type LabelRuntimeStatus } from "../model-lab/labelModels";
import type { AgreementTracker, LabelAgreement } from "./agreement";
import type { GestureDefinition } from "./definition";

type Props = {
  tracker: AgreementTracker;
  definitions: GestureDefinition[];
  status: LabelRuntimeStatus | null;
  cameraOn: boolean;
};

/** Feeds the label runtime's detections to the tracker for as long as the page is open. */
function useModelDetections(tracker: AgreementTracker, desktopAvailable: boolean): void {
  useEffect(() => {
    if (!desktopAvailable) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void Promise.resolve(
      listen<DetectionReport>(LABEL_DETECTIONS_EVENT, ({ payload }) => {
        const now = performance.now();
        for (const event of payload.events) if (event.kind === "rising") tracker.modelDetected(event.label, now);
      }),
    )
      .then((fn) => (disposed ? fn?.() : (unlisten = fn)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [tracker, desktopAvailable]);
}

const ms = (value: number | null) => (value === null ? "–" : `${Math.round(value)} ms`);

/**
 * Checks a deployed model against the camera while you perform: each time the camera sees a gesture linked to a label the
 * model is loaded for, did the model notice it, how late, and did it fire when you did nothing. Nothing is saved.
 */
export function AgreementPanel({ tracker, definitions, status, cameraOn }: Props) {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  useModelDetections(tracker, desktopAvailable);
  const [rows, setRows] = useState<{ label: string; name: string; summary: LabelAgreement }[]>([]);

  const loaded = status?.loadedLabels ?? [];
  const pairs = definitions.filter((d) => d.labelId && loaded.includes(d.labelId));
  const mode = status?.mode ?? "off";
  const ready = cameraOn && mode !== "off" && pairs.length > 0;

  useEffect(() => {
    const refresh = () => {
      const now = performance.now();
      setRows(pairs.map((d) => ({ label: d.labelId!, name: d.name, summary: tracker.summarize(d.labelId!, now) })));
    };
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
    // `pairs` is rebuilt every render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracker, pairs.map((d) => d.id).join(",")]);

  return (
    <Card role="region" aria-label="Model against camera">
      <CardHeader>
        <SectionHeader
          title="Model against camera"
          description="Perform a gesture and see whether the watch model notices it."
          status={<Button type="button" variant="outline" onClick={() => { tracker.reset(); setRows((r) => r.map((row) => ({ ...row, summary: tracker.summarize(row.label, performance.now()) }))); }}>Start over</Button>}
          help={{
            label: "About model against camera",
            content: "The camera sees your hand directly, so a gesture it recognises is taken as what really happened. This counts how often the watch model noticed the same gesture (and how long it took), how often it missed one, and how often it fired when your hand was in view and you were not doing the gesture. Detections while your hand is out of the camera's view cannot be judged and are listed separately. Wear the watch on the hand the camera sees, and set the model runtime to Monitor or Live in Model Lab.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!ready ? (
          <p className="hint" role="status">
            {!cameraOn ? "Turn the camera on above. " : ""}
            {mode === "off" ? "Set the model runtime to Monitor in Model Lab. " : ""}
            {pairs.length === 0 ? "Needs a gesture in the library linked to a label that has an active model." : ""}
          </p>
        ) : (
          <table className="agreement-table" aria-label="Model against camera, by label">
            <thead><tr><th>Gesture</th><th>Camera saw</th><th>Model found</th><th>Missed</th><th>False alarms</th><th>Out of view</th><th>Typical delay</th></tr></thead>
            <tbody>
              {rows.map(({ label, name, summary }) => (
                <tr key={label}>
                  <th scope="row">{name}</th>
                  <td>{summary.holds}</td><td>{summary.found}</td><td>{summary.missed}</td><td>{summary.falseAlarms}</td><td>{summary.unverified}</td><td>{ms(summary.medianDelayMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="field-hint">Counts start when this page opens or when you press Start over. Delay includes the time the detection takes to reach the app.</p>
      </CardContent>
    </Card>
  );
}
