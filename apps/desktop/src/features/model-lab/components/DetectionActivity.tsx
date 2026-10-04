import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import {
  LABEL_DETECTIONS_EVENT,
  appendActivity,
  describeReport,
  type ActivityEntry,
  type ActivityTone,
  type DetectionReport,
} from "../labelModels";

const TONE: Record<ActivityTone, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  detected: { label: "Detected", variant: "default" },
  released: { label: "Released", variant: "secondary" },
  warning: { label: "Attention", variant: "destructive" },
};

/** What the models have been doing this session: detections, releases, and anything that held one off. */
export function DetectionActivity({ desktopAvailable }: { desktopAvailable: boolean }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    if (!desktopAvailable) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void Promise.resolve(
      listen<DetectionReport>(LABEL_DETECTIONS_EVENT, ({ payload }) => {
        if (disposed) return;
        const lines = describeReport(payload);
        if (lines.length > 0) setEntries((previous) => appendActivity(previous, lines, () => nextId.current++));
      }),
    )
      .then((fn) => {
        if (disposed) fn?.();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktopAvailable]);

  return (
    <Card id="lab-activity" role="region" aria-label="Detection activity" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Activity"
          description="Detections and releases from active models, newest first."
          help={{
            label: "About activity",
            content: "In Monitor you see what the models would have done; in Live the same detections can start recipes. A release is always shown, in every mode. A line marked Attention means a window was skipped or two labels that cannot coexist were both detected.",
          }}
        />
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="hint">Nothing yet. Activate a model, set the runtime to Monitor and perform the gesture.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Recent detections">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2 text-sm">
                <Badge variant={TONE[entry.tone].variant}>{TONE[entry.tone].label}</Badge>
                <span>{entry.text}</span>
                {entry.count > 1 && <small className="text-muted-foreground">×{entry.count}</small>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
