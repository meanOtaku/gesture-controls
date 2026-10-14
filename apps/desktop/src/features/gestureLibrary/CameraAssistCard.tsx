import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SectionHeader } from "../../components/app/SectionHeader";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { NOT_SLOW, nextSlowState, type SlowState } from "../camera/slowWarning";
import { CameraQuickControl } from "../camera/components/CameraQuickControl";
import { getCameraController } from "../camera/cameraService";
import { cameraAssist } from "./cameraAssist";
import { definitionsForLabels, type GestureDefinition } from "./definition";
import { listGestureDefinitions } from "./gestureLibraryApi";
import { useLiveGestures } from "./useLiveGestures";

/**
 * Lets the camera do the labelling: with this on, a recording of the chosen label is marked automatically wherever the
 * camera sees that label's library gesture. Shows live whether the camera sees it right now, so you can check before you
 * start. Everything it adds is unreviewed, like any other interval.
 */
export function CameraAssistCard({
  selectedLabel,
  extraLabels = [],
  onToggleExtraLabel,
  recording,
  desktopAvailable,
}: {
  selectedLabel: string | null;
  /** Labels besides the selected one that the camera also marks. */
  extraLabels?: string[];
  onToggleExtraLabel?: (label: string) => void;
  recording: boolean;
  desktopAvailable: boolean;
}) {
  const camera = getCameraController();
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  const { enabled } = useSyncExternalStore(cameraAssist.subscribe, cameraAssist.getSnapshot, cameraAssist.getSnapshot);
  const [definitions, setDefinitions] = useState<GestureDefinition[]>([]);

  useEffect(() => {
    if (!desktopAvailable) return;
    void listGestureDefinitions().then((found) => setDefinitions(found ?? [])).catch(() => setDefinitions([]));
  }, [desktopAvailable]);

  // Stable between renders, or the live detector would restart on every frame.
  const labelKey = [selectedLabel, ...extraLabels].join("\u0000");
  const markLabels = useMemo(() => (selectedLabel === null ? [] : [selectedLabel, ...extraLabels]), [labelKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = useMemo(() => definitionsForLabels(definitions, markLabels), [definitions, markLabels]);
  // Labels the library has a gesture for, to offer as additions to the selected one.
  const offered = useMemo(() => Array.from(new Set(definitions.map((d) => d.labelId).filter((id): id is string => id !== null))).filter((id) => id !== selectedLabel).sort(), [definitions, selectedLabel]);
  const withoutGesture = markLabels.filter((label) => !mine.some((d) => d.labelId === label));
  const camera2 = getCameraController("secondary");
  const cam2 = useSyncExternalStore(camera2.subscribe, camera2.getSnapshot, camera2.getSnapshot);
  const states = useLiveGestures(mine, cam, undefined, cam2);
  const heldLabels = Array.from(new Set(mine.filter((definition) => states.get(definition.id)?.held).map((definition) => definition.labelId as string)));
  const seen = heldLabels.length > 0;

  const camOn = cam.status === "on" || cam2.status === "on";

  // The slowest camera that is running: warned about only once it has stayed slow, and until it is clearly back up.
  const running = [cam, cam2].filter((c) => c.status === "on" && c.fps > 0);
  const slowest = running.length === 0 ? null : running.reduce((a, b) => (b.fps < a.fps ? b : a));
  const slowState = useRef<SlowState>(NOT_SLOW);
  const [slow, setSlow] = useState(false);
  const slowestFps = slowest?.fps ?? null;
  useEffect(() => {
    slowState.current = nextSlowState(slowState.current, recording ? slowestFps : null, Date.now());
    setSlow(slowState.current.slow);
  }, [slowestFps, recording]);

  const blocker = !desktopAvailable
    ? "Needs the desktop app."
    : selectedLabel === null
      ? "Choose a label above first."
      : withoutGesture.length > 0
        ? `No gesture in the Gesture library uses ${withoutGesture.map((label) => `“${label.replaceAll("_", " ")}”`).join(", ")}. Make one there first, or drop ${withoutGesture.length === 1 ? "that label" : "those labels"}.`
        : !camOn
          ? "Turn the camera on (below) so it can see your hand."
          : !cam.recordLandmarks
            ? "Saving hand landmarks is switched off in Camera hand tracking (below)."
            : null;

  // Tells the Recorder whether a recording started now will be marked, so it only changes how it records when it can work.
  useEffect(() => {
    cameraAssist.setReady(blocker === null && markLabels.length > 0 ? markLabels : null, mine);
    return () => cameraAssist.setReady(null);
  }, [blocker, markLabels, mine]);

  return (
    <Card role="region" aria-label="Camera marking" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Let the camera mark it"
          description="Mark the gesture in your recording automatically, using the camera."
          help={{
            label: "About camera marking",
            content: "Record as usual with the watch worn on the hand the camera sees. You can mark several labels in one recording: pick one above, then add others here. Only one label is on at a time; if two gestures are held together the one that began last is marked, and the other takes over if it is still held when that ends. While you record, the label is switched on in the watch data whenever the camera sees the label's gesture from the Gesture library, and off when you let go, just like holding the Mark label button. The PPG and motion rows in between carry the label, in the recording and in the exported CSV. Everything it marks starts unreviewed, and nothing is marked if the camera never sees the gesture.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-2 text-sm">
          <Checkbox checked={enabled} disabled={recording} onCheckedChange={(on) => cameraAssist.setEnabled(on === true)} aria-label="Let the camera mark the gesture" />
          <span><strong>Let the camera mark the gesture</strong> <small className="text-muted-foreground">On by default. When the camera is on and the label has a gesture, the recording is a timeline and the camera marks the label live, while you record.</small></span>
        </div>
        {enabled && (offered.length > 0 || extraLabels.length > 0) && onToggleExtraLabel && (
          <div className="flex flex-col gap-1.5" role="group" aria-label="Also mark these labels">
            <span className="text-xs text-muted-foreground">Also mark in the same recording (labels with a gesture in the library)</span>
            <div className="flex flex-wrap gap-2">
              {Array.from(new Set([...offered, ...extraLabels])).sort().map((label) => {
                const on = extraLabels.includes(label);
                return (
                  <Button key={label} type="button" size="sm" className="text-xs" variant={on ? "default" : "outline"} aria-pressed={on} disabled={recording} onClick={() => onToggleExtraLabel(label)}>
                    {label.replaceAll("_", " ")}
                  </Button>
                );
              })}
            </div>
          </div>
        )}
        {enabled && blocker && <p className="hint" role="status">{blocker} Until then, recordings are made as usual with no camera marks.</p>}
        {enabled && !blocker && recording && slow && slowest && (
          <p className="hint" role="status">The camera is running slowly ({slowest.fps.toFixed(0)} frames a second{slowest.detectMs > 0 ? `, ${slowest.detectMs.toFixed(0)} ms for each hand-tracking pass` : ""}), so the start and end of marks may be a little off. Close other apps using the camera or the processor, or turn the second camera off.</p>
        )}
        {enabled && !blocker && (
          <div className="flex flex-wrap items-center gap-3" role="status">
            <Badge variant={seen ? "default" : "secondary"}>
              {seen
                ? markLabels.length > 1
                  ? `Camera sees ${heldLabels.map((label) => label.replaceAll("_", " ")).join(", ")}`
                  : "Camera sees it"
                : markLabels.length > 1 ? "Camera does not see any" : "Camera does not see it"}
            </Badge>
            <span className="hint">{recording ? "Recording. Perform the gesture, with the watch hand in view." : "Perform the gesture now to check, then start recording."}</span>
          </div>
        )}
        {enabled && <CameraQuickControl />}
      </CardContent>
    </Card>
  );
}
