import { AnimatedNumber, AnimatedText } from "../../../components/app/AnimatedNumber";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDownIcon, ChevronRightIcon, Trash2Icon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { LiveBeam } from "../../../components/app/LiveBeam";
import { CameraQuickControl } from "../../camera/components/CameraQuickControl";
import { useLabelDetections } from "../../gestures/useLabelDetections";
import { MissButtons } from "../../misses/MissMarker";
import {
  HAND_STEADINESS_EVENT,
  LABEL_DETECTIONS_EVENT,
  appendActivity,
  describeReport,
  describeSteadiness,
  type ActivityEntry,
  type ActivityTone,
  type DetectionReport,
  type HandSteadiness,
} from "../labelModels";

const OPEN_KEY = "labActivityOpen";

/** Whether the card was left open, remembered between visits. A browser that will not say means open. */
function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

const TONE: Record<ActivityTone, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  detected: { label: "Detected", variant: "default" },
  released: { label: "Released", variant: "secondary" },
  warning: { label: "Attention", variant: "destructive" },
};

/** Whether the hand is still right now. A gesture may only start when it was still just before, so this says why one did not. */
function HandSteadinessBadge({ desktopAvailable }: { desktopAvailable: boolean }) {
  const [steadiness, setSteadiness] = useState<HandSteadiness | null>(null);
  useEffect(() => {
    if (!desktopAvailable) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void Promise.resolve()
      .then(() => invoke<HandSteadiness>("get_hand_steadiness"))
      .then((now) => { if (!disposed) setSteadiness(now); })
      .catch(() => undefined);
    void Promise.resolve(listen<HandSteadiness>(HAND_STEADINESS_EVENT, ({ payload }) => { if (!disposed) setSteadiness(payload); }))
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
  if (!desktopAvailable) return null;
  const { text, variant } = describeSteadiness(steadiness);
  return <Badge variant={variant} aria-live="polite">{text}</Badge>;
}

/** What the models have been doing this session: detections, releases, and anything that held one off. */
export function DetectionActivity({ desktopAvailable }: { desktopAvailable: boolean }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [open, setOpen] = useState(readOpen);
  const bodyId = useId();
  const nextId = useRef(0);
  const detections = useLabelDetections(desktopAvailable);

  const toggle = () =>
    setOpen((current) => {
      try {
        window.localStorage.setItem(OPEN_KEY, String(!current));
      } catch {
        // Remembering is a convenience; the card still works without it.
      }
      return !current;
    });

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
          description="Detections and releases from active models, newest first, with the camera beside them to check against."
          status={
            <div className="flex items-center gap-2">
              <HandSteadinessBadge desktopAvailable={desktopAvailable} />
              <Button type="button" variant="ghost" disabled={entries.length === 0} onClick={() => setEntries([])}>
                <Trash2Icon aria-hidden="true" />
                Clear
              </Button>
              <Button type="button" variant="ghost" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
                {open ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
                <AnimatedText>{open ? "Collapse" : `Expand${entries.length > 0 ? ` (${entries.length})` : ""}`}</AnimatedText>
              </Button>
            </div>
          }
          help={{
            label: "About activity",
            content: "In Monitor you see what the models would have done; in Live the same detections can start recipes. A release is always shown, in every mode. A line marked Attention means a window was skipped, two labels that cannot coexist were both detected, or a gesture was not started because the hand was moving just before it. The badge says whether the hand is still right now: a gesture only starts when the watch was still for the second before it.",
          }}
        />
      </CardHeader>
      <CardContent id={bodyId} hidden={!open} className="lab-monitor">
        <div className="lab-monitor-camera relative overflow-hidden rounded-md p-2" role="group" aria-label="Camera check">
          <LiveBeam active={detections.detected.size > 0} />
          <CameraQuickControl compact initiallyShown />
          <p className="hint">
            Turn the camera on to watch your hand beside what the models say. When they disagree with what you see, mark it:
            the last 45 seconds are saved to Datasets under “Misses”, with the camera's view of your hand, so you can check
            afterwards what really happened.
          </p>
          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            {[...detections.detected].sort().map((label) => <Badge key={label}>{label}: detected now</Badge>)}
            {detections.detected.size === 0 && <Badge variant="secondary">Nothing detected right now</Badge>}
          </div>
          <MissButtons className="flex flex-wrap gap-2" />
        </div>
        <div className="lab-monitor-log">
        {entries.length === 0 ? (
          <p className="hint">Nothing yet. Activate a model, set the runtime to Monitor and perform the gesture.</p>
        ) : (
          // A fixed height that scrolls, so a long session does not make the page longer. Focusable so the keyboard can scroll it.
          <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1" aria-label="Recent detections" tabIndex={0}>
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2 text-sm">
                <Badge variant={TONE[entry.tone].variant}>{TONE[entry.tone].label}</Badge>
                <span>{entry.text}</span>
                {entry.count > 1 && <small className="text-muted-foreground">×{<AnimatedNumber value={entry.count} />}</small>}
              </li>
            ))}
          </ul>
        )}
        </div>
      </CardContent>
    </Card>
  );
}
