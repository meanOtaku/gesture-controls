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
import { definitionsForLabel, type GestureDefinition } from "./definition";
import { listGestureDefinitions } from "./gestureLibraryApi";
import { useLiveGestures } from "./useLiveGestures";

/**
 * Lets the camera do the labelling: with this on, a recording of the chosen label is marked automatically wherever the
 * camera sees that label's library gesture. Shows live whether the camera sees it right now, so you can check before you
 * start. Everything it adds is unreviewed, like any other interval.
 */
export function CameraAssistCard({ selectedLabel, recording, desktopAvailable }: { selectedLabel: string | null; recording: boolean; desktopAvailable: boolean }) {
  const camera = getCameraController();
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  const { enabled } = useSyncExternalStore(cameraAssist.subscribe, cameraAssist.getSnapshot, cameraAssist.getSnapshot);
  const [definitions, setDefinitions] = useState<GestureDefinition[]>([]);

  useEffect(() => {
    if (!desktopAvailable) return;
    void listGestureDefinitions().then(setDefinitions).catch(() => setDefinitions([]));
  }, [desktopAvailable]);

  // Stable between renders, or the live detector would restart on every frame.
  const mine = useMemo(() => definitionsForLabel(definitions, selectedLabel), [definitions, selectedLabel]);
  const camera2 = getCameraController("secondary");
  const cam2 = useSyncExternalStore(camera2.subscribe, camera2.getSnapshot, camera2.getSnapshot);
  const states = useLiveGestures(mine, cam, undefined, cam2);
  const heldNow = mine.map((definition) => states.get(definition.id)).filter((state) => state?.held);
  const seen = heldNow.length > 0;

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
      : mine.length === 0
        ? `No gesture in the Gesture library uses “${selectedLabel.replaceAll("_", " ")}”. Make one there first.`
        : !camOn
          ? "Turn the camera on (below) so it can see your hand."
          : !cam.recordLandmarks
            ? "Saving hand landmarks is switched off in Camera hand tracking (below)."
            : null;

  // Tells the Recorder whether a recording started now will be marked, so it only changes how it records when it can work.
  useEffect(() => {
    cameraAssist.setReady(blocker === null ? selectedLabel : null, mine);
    return () => cameraAssist.setReady(null);
  }, [blocker, selectedLabel, mine]);

  return (
    <Card role="region" aria-label="Camera marking" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Let the camera mark it"
          description="Mark the gesture in your recording automatically, using the camera."
          help={{
            label: "About camera marking",
            content: "Record as usual with the watch worn on the hand the camera sees. While you record, the label is switched on in the watch data whenever the camera sees the label's gesture from the Gesture library, and off when you let go, just like holding the Mark label button. The PPG and motion rows in between carry the label, in the recording and in the exported CSV. Everything it marks starts unreviewed, and nothing is marked if the camera never sees the gesture.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-2 text-sm">
          <Checkbox checked={enabled} disabled={recording} onCheckedChange={(on) => cameraAssist.setEnabled(on === true)} aria-label="Let the camera mark the gesture" />
          <span><strong>Let the camera mark the gesture</strong> <small className="text-muted-foreground">On by default. When the camera is on and the label has a gesture, the recording is a timeline and the camera marks the label live, while you record.</small></span>
        </div>
        {enabled && blocker && <p className="hint" role="status">{blocker} Until then, recordings are made as usual with no camera marks.</p>}
        {enabled && !blocker && recording && slow && slowest && (
          <p className="hint" role="status">The camera is running slowly ({slowest.fps.toFixed(0)} frames a second{slowest.detectMs > 0 ? `, ${slowest.detectMs.toFixed(0)} ms for each hand-tracking pass` : ""}), so the start and end of marks may be a little off. Close other apps using the camera or the processor, or turn the second camera off.</p>
        )}
        {enabled && !blocker && (
          <div className="flex flex-wrap items-center gap-3" role="status">
            <Badge variant={seen ? "default" : "secondary"}>{seen ? "Camera sees it" : "Camera does not see it"}</Badge>
            <span className="hint">{recording ? "Recording. Perform the gesture, with the watch hand in view." : "Perform the gesture now to check, then start recording."}</span>
          </div>
        )}
        {enabled && <CameraQuickControl />}
      </CardContent>
    </Card>
  );
}
