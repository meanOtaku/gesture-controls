import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SectionHeader } from "../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import { getDroneSnapshot, subscribeDrone, type DroneState } from "./droneStatus";

export type { DroneFlow, DroneState } from "./droneStatus";

const POLL_MS = 100;
const HEARTBEAT_MS = 100;
/** How hard the height buttons push the throttle, within the backend's limit. */
const HEIGHT_RATE = 30;
const FRAME_POLL_MS = 60;
/** The measure works on a 160 by 90 picture, so the marker is scaled up to the 640 by 360 view. */
const VIEW_SCALE = 4;
/** Below this the measure is not trusted, matching `vision::MIN_CONFIDENCE`. */
const MIN_CONFIDENCE = 0.25;

/** Frame bytes are the frame number, four little-endian bytes, followed by a JPEG. */
export function parseFrame(bytes: ArrayBuffer): { number: number; jpeg: Blob } | null {
  if (bytes.byteLength <= 4) return null;
  return {
    number: new DataView(bytes).getUint32(0, true),
    jpeg: new Blob([bytes.slice(4)], { type: "image/jpeg" }),
  };
}

function useLiveVideo(active: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const shown = useRef(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;
    let current: string | null = null;
    const fetchFrame = () => {
      if (inFlight) return;
      inFlight = true;
      invoke<ArrayBuffer>("drone_frame", { after: shown.current })
        .then((bytes) => {
          const frame = bytes ? parseFrame(bytes) : null;
          if (!frame || cancelled) return;
          shown.current = frame.number;
          const next = URL.createObjectURL(frame.jpeg);
          if (current) URL.revokeObjectURL(current);
          current = next;
          setUrl(next);
        })
        .catch(() => {})
        .finally(() => { inFlight = false; });
    };
    const timer = window.setInterval(fetchFrame, FRAME_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (current) URL.revokeObjectURL(current);
      setUrl(null);
    };
  }, [active]);

  return url;
}

const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;

function LiveView({ url, state }: { url: string | null; state: DroneState | null }) {
  const trusted = state?.flow != null && state.flow.confidence >= MIN_CONFIDENCE;
  const x = 320 + (state?.driftX ?? 0) * VIEW_SCALE;
  const y = 180 + (state?.driftY ?? 0) * VIEW_SCALE;
  return (
    <div style={{ position: "relative", width: "100%", maxWidth: 640, aspectRatio: "16 / 9", background: "#000" }}>
      {url
        ? <img src={url} alt="Live view from the drone" style={{ width: "100%", height: "100%", filter: "brightness(2.2)" }} />
        : <p className="subtitle" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", margin: 0, color: "#fff" }}>No video</p>}
      <svg viewBox="0 0 640 360" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <path d="M310 180h20M320 170v20" stroke="#fff" strokeOpacity="0.7" strokeWidth="1.5" />
        {url && (
          <>
            <line x1="320" y1="180" x2={x} y2={y} stroke={trusted ? "#4ade80" : "#f87171"} strokeWidth="2" />
            <circle cx={x} cy={y} r="6" fill="none" stroke={trusted ? "#4ade80" : "#f87171"} strokeWidth="2" />
          </>
        )}
      </svg>
    </div>
  );
}

const PHASE_LABEL: Record<DroneState["phase"], string> = {
  disconnected: "Not connected",
  opening: "Connecting",
  open: "Connected",
  failed: "No answer from the drone",
  closed: "Closed",
};

/** Flies a Wi-Fi drone from the watch. The backend enforces every rule here; the page only shows and asks. */
export function DronePage() {
  const [state, setState] = useState<DroneState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    const refresh = () => {
      invoke<DroneState>("get_drone_state")
        .then((next) => { if (!cancelled) setState(next); })
        .catch((reason) => { if (!cancelled) setError(String(reason)); });
    };
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const run = useCallback((command: string) => {
    setError(null);
    invoke<DroneState | null>(command)
      .then((next) => { if (next) setState(next); })
      .catch((reason) => setError(String(reason)));
  }, []);

  const runHold = useCallback((enabled: boolean) => {
    setError(null);
    invoke<DroneState>("drone_set_hold", { enabled })
      .then(setState)
      .catch((reason) => setError(String(reason)));
  }, []);

  const connected = state?.phase === "open";
  const linked = connected || state?.phase === "opening";
  const videoUrl = useLiveVideo(connected);
  const flow = state?.flow ?? null;
  const frameRate = useSyncExternalStore(subscribeDrone, getDroneSnapshot, getDroneSnapshot)?.videoRate;

  // Keeps the link alive while this page is open. If the page dies, the pilot lands.
  const height = useRef(0);
  useEffect(() => {
    if (!connected) return;
    const beat = () => { void Promise.resolve(invoke("drone_heartbeat", { height: height.current })).catch(() => {}); };
    const release = () => { height.current = 0; };
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    window.addEventListener("blur", release);
    window.addEventListener("pointerup", release);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("blur", release);
      window.removeEventListener("pointerup", release);
      release();
    };
  }, [connected]);

  const heightButton = (label: string, rate: number) => (
    <Button
      variant="outline"
      disabled={!state?.armed}
      onPointerDown={() => { height.current = rate; }}
      onPointerUp={() => { height.current = 0; }}
      onPointerLeave={() => { height.current = 0; }}
    >
      {label}
    </Button>
  );

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Drone</h1>
          <p className="subtitle">Tilt your wrist to move a Wi-Fi drone. Hold the watch button to steer, and let go to stop steering.</p>
        </div>
      </header>

      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      {state?.failsafeTripped && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>Nothing was keeping the link alive, so the drone was told to land. Arm again to carry on.</AlertDescription>
        </Alert>
      )}

      {state?.holdFault && <Alert variant="destructive" role="alert"><AlertDescription>{state.holdFault}</AlertDescription></Alert>}

      <Card role="region" aria-label="Connection">
        <CardHeader>
          <SectionHeader
            title="Connection"
            description={!state ? "Only available in the desktop app"
              : state.phase === "disconnected" ? (state.onNetwork ? "Not connected" : "Waiting for the drone's Wi-Fi")
                : PHASE_LABEL[state.phase]}
            help={{
              label: "About connecting",
              content: "Join the drone's Wi-Fi on this computer and the app connects by itself, which never arms or starts the drone. Disconnect stays that way until you choose Connect or leave the Wi-Fi. The watch must use Bluetooth, because the Wi-Fi is taken by the drone.",
            }}
          />
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          {linked
            ? <Button variant="outline" onClick={() => run("drone_disconnect")}>Disconnect</Button>
            : <Button disabled={!state} onClick={() => run("drone_connect")}>Connect</Button>}
          {state && (
            <p className="subtitle">
              {state.firmware && <>Firmware {state.firmware}. </>}Video {frameRate ?? "–"} frames a second, total {state.videoFrames}, skipped {state.videoSkipped}, damaged {state.videoDamaged}, commands sent {state.framesSent}, send errors {state.sendErrors}, watch {state.watchStreaming ? "streaming" : "not streaming"}
            </p>
          )}
        </CardContent>
      </Card>

      <Card role="region" aria-label="Camera tracking">
        <CardHeader>
          <SectionHeader
            title="Camera tracking"
            description={flow ? `Agreement ${Math.round(flow.confidence * 100)}%` : "Waiting for two good frames"}
            help={{
              label: "About camera tracking",
              content: "The app follows the picture the way a mouse follows a desk. The marker shows how far the view has moved since you pressed Set centre: green when the measure is trusted, red when the view is too blank or dark. Hold position first gives the drone gentle test pushes both ways, about nine seconds in all, to measure which way the sticks move the picture and how far. It then keeps the view where it was. Would send shows the corrections, which reach the drone only while hold is on.",
            }}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <LiveView url={videoUrl} state={state} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={!connected} onClick={() => run("drone_reset_drift")}>Set centre</Button>
            {state && (
              <p className="subtitle">
                Drift {state.driftX.toFixed(1)}, {state.driftY.toFixed(1)} px
                {flow && `, zoom ${(flow.zoom * 100).toFixed(1)}%`}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {state?.holding
              ? <Button variant="outline" onClick={() => runHold(false)}>Stop holding</Button>
              : <Button disabled={!state?.armed} onClick={() => runHold(true)}>Hold position</Button>}
            {state && (
              <p className="subtitle">
                {state.holdPhase === "calibrating" ? "Measuring the drone, sending" : state.holding ? "Sending" : "Would send"}{" "}
                {state.correction
                  ? `aileron ${signed(state.correction.aileron)}, elevator ${signed(state.correction.elevator)}`
                  : "nothing: the picture cannot be trusted"}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card role="region" aria-label="Flight">
        <CardHeader>
          <SectionHeader
            title="Flight"
            description={!state?.armed ? "Not armed"
              : state.holdPhase === "calibrating" ? "Armed, measuring the drone"
                : state.holdPhase === "holding" ? "Armed, holding position"
                  : state.steering ? "Armed, steering" : "Armed"}
            help={{
              label: "About flying",
              content: "Arming lasts until you land, and this page must stay open: if it closes, the drone is told to land. Hold Climb or Descend to change height, which works while the position is held. Calibrate gyro only works before arming: stand the drone on a flat surface and keep it still. Esc lands from any page while this window is focused. Stop may cut the motors in the air, so use it only if landing fails. If the watch goes quiet for a second the drone is told to land.",
            }}
          />
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={!connected || state?.armed} onClick={() => run("drone_calibrate_gyro")}>Calibrate gyro</Button>
          <Button disabled={!connected || state?.armed || !(state?.watchStreaming || state?.pageAlive)} onClick={() => run("drone_arm")}>Arm</Button>
          <Button disabled={!state?.armed} onClick={() => run("drone_take_off")}>Take off</Button>
          {heightButton("Climb", HEIGHT_RATE)}
          {heightButton("Descend", -HEIGHT_RATE)}
          <Button variant="outline" disabled={!linked} onClick={() => run("drone_land")}>Land</Button>
          <Button variant="destructive" disabled={!linked} onClick={() => run("drone_stop")}>Stop</Button>
          {state?.flightLog && <p className="subtitle">Recording this flight to {state.flightLog}</p>}
        </CardContent>
      </Card>
    </main>
  );
}
