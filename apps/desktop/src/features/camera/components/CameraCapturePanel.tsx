import { useId, useSyncExternalStore } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Label } from "../../../components/ui/label";
import { telemetryStore } from "../../telemetry/store/telemetryStore";
import { clockSync } from "../clockSync";
import { getCameraController } from "../cameraService";
import { physicalHand } from "../handTypes";
import { measureHand } from "../landmarkMath";
import { CameraPreview } from "./CameraPreview";

const NATIVE_SELECT = "recipe-select";

/**
 * The camera: a mirror-view preview with the hand landmarks drawn on it, and the switch that saves the landmarks with
 * each recording. Only landmarks are ever saved, never the picture. The camera itself belongs to the app (see
 * `cameraService`), not to this page, so a recording keeps its pictures when you leave.
 */
export function CameraCapturePanel() {
  const camera = getCameraController();
  const state = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const deviceId = useId();
  const on = state.status === "on";
  const starting = state.status === "starting";
  const sync = clockSync.estimate();
  const watchStreaming = telemetryStore.getWatchStatus()?.connected === true;
  const hands = state.frame?.hands ?? [];
  const measures = hands.map((hand) => ({ hand, measures: measureHand(hand) }));

  return (
    <Card role="region" aria-label="Camera hand tracking" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Camera hand tracking"
          description="Saves your hand's landmarks with each recording, for labelling gestures."
          status={
            <Button type="button" variant={on ? "outline" : "default"} disabled={starting} onClick={() => (on ? camera.disable() : void camera.enable())}>
              {starting ? "Starting…" : on ? "Turn camera off" : "Turn camera on"}
            </Button>
          }
          help={{
            label: "About camera hand tracking",
            content: "A model on this computer finds 21 points on each hand in the camera picture. While you record, those points are saved with the recording, along with when each picture was taken, so they can be lined up with the watch afterwards. The picture itself is never saved, and nothing leaves this computer. Keep the hand that wears the watch in view.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        <CameraPreview camera={camera} state={state} hidden={!on} />
        {starting && <p className="hint" role="status">Starting the camera and the hand model. If your computer asks for camera permission, allow it.</p>}
        {!on && !starting && !state.error && <p className="hint">The camera is off. Turn it on to see your hand tracked, and to save landmarks with recordings.</p>}
        {on && state.devices.length > 1 && (
          <div className="field">
            <div className="field-head"><Label htmlFor={deviceId}>Camera</Label></div>
            <select id={deviceId} className={NATIVE_SELECT} value={state.deviceId ?? ""} onChange={(event) => void camera.enable(event.target.value)}>
              {state.devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
            </select>
          </div>
        )}
        {on && (
          <>
            <ul className="flex flex-wrap items-center gap-2" aria-label="Tracking status">
              <li><Badge variant={hands.length > 0 ? "default" : "secondary"}>{hands.length === 0 ? "No hand in view" : hands.length === 1 ? "1 hand" : `${hands.length} hands`}</Badge></li>
              <li><Badge variant="outline">{state.fps > 0 ? `${state.fps.toFixed(0)} frames/s` : "waiting for frames"}</Badge></li>
              {hands.map((hand, index) => (
                <li key={index}><Badge variant="outline">{physicalHand(hand)} hand · {Math.round(hand.score * 100)}%</Badge></li>
              ))}
            </ul>
            {measures.map(({ hand, measures: m }, index) => (
              <div key={index} className="camera-measure" role="meter" aria-label={`Thumb to index distance, ${physicalHand(hand)} hand`} aria-valuemin={0} aria-valuemax={150} aria-valuenow={m?.pinch.index == null ? 0 : Math.round(Math.min(1.5, m.pinch.index) * 100)}>
                <span>Thumb to index</span>
                <div className="gesture-meter"><div className="gesture-meter-fill" style={{ width: `${m?.pinch.index == null ? 0 : Math.min(100, (m.pinch.index / 1.5) * 100)}%` }} /></div>
                <small>{m?.pinch.index == null ? "no reading" : `${m.pinch.index.toFixed(2)} hand sizes`}</small>
              </div>
            ))}
          </>
        )}
        <div className="flex items-start gap-2 text-sm">
          <Checkbox checked={state.recordLandmarks} onCheckedChange={(checked) => camera.setRecordLandmarks(checked === true)} aria-label="Save hand landmarks with recordings" />
          <span><strong>Save hand landmarks with recordings</strong> <small className="text-muted-foreground">Only the 21 points per hand and when they were seen, never the picture.</small></span>
        </div>
        <p className="field-hint" role="status">
          {state.collecting
            ? `Recording the camera: ${state.collectedFrames} frames kept${state.truncated ? " (the limit was reached, so the end of this recording has no camera data)" : ""}.`
            : !watchStreaming
              ? "Clock alignment with the watch starts once the watch is streaming."
              : sync
                ? `Clock alignment with the watch: ${sync.samples} samples, link jitter about ${sync.jitterMs.toFixed(0)} ms.`
                : "Clock alignment with the watch: collecting samples…"}
        </p>
      </CardContent>
    </Card>
  );
}
