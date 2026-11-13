import { AnimatedNumber } from "../../components/app/AnimatedNumber";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SectionHeader } from "../../components/app/SectionHeader";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { NOT_SLOW, nextSlowState, type SlowState } from "../camera/slowWarning";
import { CameraQuickControl } from "../camera/components/CameraQuickControl";
import { getCameraController } from "../camera/cameraService";
import { measureHand } from "../camera/landmarkMath";
import type { HandFrame } from "../camera/handTypes";
import { contactThreshold } from "../labelling/cameraTrack";
import { cameraAssist } from "./cameraAssist";
import { PINCH_IN, PINCH_LABELS, wantsPinchEdges } from "./pinchEdgeMarker";
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
  embedded = false,
}: {
  selectedLabel: string | null;
  /** Labels besides the selected one that the camera also marks. */
  extraLabels?: string[];
  onToggleExtraLabel?: (label: string) => void;
  recording: boolean;
  desktopAvailable: boolean;
  /** Inside another card (the Recorder's Record a gesture), with the camera shown beside it: no card of its own. */
  embedded?: boolean;
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
  // Pinch in and pinch out together are marked from the finger distance itself, with no library gesture needed.
  const edges = wantsPinchEdges(markLabels);
  const partners = selectedLabel !== null && PINCH_LABELS.includes(selectedLabel) ? PINCH_LABELS.filter((label) => label !== selectedLabel) : [];
  // Labels the library has a gesture for, to offer as additions to the selected one (and the other pinch labels).
  const offered = useMemo(
    () => Array.from(new Set([...definitions.map((d) => d.labelId).filter((id): id is string => id !== null), ...partners])).filter((id) => id !== selectedLabel).sort(),
    [definitions, selectedLabel, partners.join(",")], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const withoutGesture = edges ? [] : markLabels.filter((label) => !mine.some((d) => d.labelId === label));
  const othersWithEdges = edges ? markLabels.filter((label) => !PINCH_LABELS.includes(label)) : [];
  const contact = contactThreshold(definitions, PINCH_IN);
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
      : othersWithEdges.length > 0
        ? `Pinch in, pinch hold and pinch out are marked on their own, from the finger distance. Drop ${othersWithEdges.map((label) => `“${label.replaceAll("_", " ")}”`).join(", ")} from this recording.`
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

  const body = (
    <>
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
          <p className="hint" role="status">The camera is running slowly ({<AnimatedNumber value={slowest.fps} digits={0} />} frames a second{slowest.detectMs > 0 ? <>{", "}<AnimatedNumber value={slowest.detectMs} digits={0} />{" ms for each hand-tracking pass"}</> : ""}), so the start and end of marks may be a little off. Close other apps using the camera or the processor, or turn the second camera off.</p>
        )}
        {enabled && !blocker && edges && (
          <div className="flex flex-wrap items-center gap-3" role="status">
            <FingerBadge frames={[cam.frame, cam2.frame]} contact={contact} />
            <span className="hint">{recording ? "Recording. Touch thumb and index, hold, and let go, with a few still seconds between." : "Touch thumb and index now to check, then start recording."}</span>
          </div>
        )}
        {enabled && !blocker && !edges && (
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
        {enabled && !embedded && <CameraQuickControl />}
    </>
  );
  if (embedded) return <div className="flex flex-col gap-3" role="group" aria-label="Camera marking">{body}</div>;

  return (
    <Card role="region" aria-label="Camera marking" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Let the camera mark it"
          description="Mark the gesture in your recording automatically, using the camera."
          help={{
            label: "About camera marking",
            content: "Record as usual with the watch worn on the hand the camera sees. For pinch in and pinch out, pick “pinch in” above and add “pinch out” here: the camera marks a short pinch in where thumb and index meet and a short pinch out where they part, from their distance, with no library gesture needed. Add “pinch hold” too to label the time in between, while the fingers stay together. You can mark several labels in one recording: pick one above, then add others here. Only one label is on at a time; if two gestures are held together the one that began last is marked, and the other takes over if it is still held when that ends. While you record, the label is switched on in the watch data whenever the camera sees the label's gesture from the Gesture library, and off when you let go, just like holding the Mark label button. The PPG and motion rows in between carry the label, in the recording and in the exported CSV. Everything it marks starts unreviewed, and nothing is marked if the camera never sees the gesture.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {body}
      </CardContent>
    </Card>
  );
}

/** Whether thumb and index are together right now, in the newest frame of either camera. */
function FingerBadge({ frames, contact }: { frames: (HandFrame | null)[]; contact: number }) {
  let closest: number | null = null;
  for (const frame of frames) {
    for (const hand of frame?.hands ?? []) {
      const distance = measureHand(hand)?.pinch.index ?? null;
      if (distance !== null && (closest === null || distance < closest)) closest = distance;
    }
  }
  const text = closest === null ? "No hand in view" : closest < contact ? "Fingers together" : "Fingers apart";
  return <Badge variant={closest !== null && closest < contact ? "default" : "secondary"}>{text}</Badge>;
}
