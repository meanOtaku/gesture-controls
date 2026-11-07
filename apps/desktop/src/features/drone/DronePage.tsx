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
/** How hard the steering buttons and arrow keys push, within the backend's limit. */
const NUDGE = 25;
const REVERSE_KEY = "droneReverse";
const TRIM_KEY = "droneTrim";
const AUTO_HOLD_KEY = "droneAutoHold";
/** The backend's trim limit. */
const MAX_TRIM = 20;

export type Trim = { aileron: number; elevator: number; rudder: number };
const NO_TRIM: Trim = { aileron: 0, elevator: 0, rudder: 0 };

function loadTrim(): Trim {
  try {
    const saved = JSON.parse(window.localStorage.getItem(TRIM_KEY) ?? "{}") as Partial<Trim>;
    const valid = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(-MAX_TRIM, Math.min(MAX_TRIM, Math.round(value))) : 0;
    return { aileron: valid(saved.aileron), elevator: valid(saved.elevator), rudder: valid(saved.rudder) };
  } catch {
    return NO_TRIM;
  }
}

function loadAutoHold(): boolean {
  try {
    return window.localStorage.getItem(AUTO_HOLD_KEY) !== "off";
  } catch {
    return true;
  }
}

function save(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Still applies for now; it is just not remembered.
  }
}

type Axis = "aileron" | "elevator";
type Reverse = Record<Axis, boolean>;

/** Which stick and which way each arrow key pushes, before any reversing. */
export const ARROWS: Record<string, [Axis, number]> = {
  ArrowUp: ["elevator", 1],
  ArrowDown: ["elevator", -1],
  ArrowLeft: ["aileron", -1],
  ArrowRight: ["aileron", 1],
};

function loadReverse(): Reverse {
  try {
    const saved = JSON.parse(window.localStorage.getItem(REVERSE_KEY) ?? "{}") as Partial<Reverse>;
    return { aileron: saved.aileron === true, elevator: saved.elevator === true };
  } catch {
    return { aileron: false, elevator: false };
  }
}
/** After an empty reply, which means no frame came within the backend's wait, pause before asking again. */
const FRAME_RETRY_MS = 50;
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
    let current: string | null = null;
    let timer: number | undefined;
    // The backend answers as soon as a new frame is ready, so each one is shown at once and the next is asked for.
    const fetchFrame = () => {
      Promise.resolve(invoke<ArrayBuffer>("drone_frame", { after: shown.current }))
        .then((bytes) => {
          const frame = bytes ? parseFrame(bytes) : null;
          if (cancelled) return;
          if (!frame) {
            timer = window.setTimeout(fetchFrame, FRAME_RETRY_MS);
            return;
          }
          shown.current = frame.number;
          const next = URL.createObjectURL(frame.jpeg);
          if (current) URL.revokeObjectURL(current);
          current = next;
          setUrl(next);
          fetchFrame();
        })
        .catch(() => { if (!cancelled) timer = window.setTimeout(fetchFrame, FRAME_RETRY_MS); });
    };
    fetchFrame();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
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

  const runMode = useCallback((command: "drone_set_headless" | "drone_set_return", enabled: boolean) => {
    setError(null);
    invoke<DroneState>(command, { enabled })
      .then(setState)
      .catch((reason) => setError(String(reason)));
  }, []);

  // Return has never been tried on this drone, so it takes a second click to confirm.
  const [confirmingReturn, setConfirmingReturn] = useState(false);
  useEffect(() => {
    if (!state?.armed || !state?.tookOff) setConfirmingReturn(false);
  }, [state?.armed, state?.tookOff]);

  const connected = state?.phase === "open";
  const linked = connected || state?.phase === "opening";
  const videoUrl = useLiveVideo(connected);
  const flow = state?.flow ?? null;
  const frameRate = useSyncExternalStore(subscribeDrone, getDroneSnapshot, getDroneSnapshot)?.videoRate;

  // Keeps the link alive while this page is open. If the page dies, the pilot lands.
  // What the buttons and arrow keys ask for. Sent with every heartbeat, so a stuck button cannot keep the drone moving.
  const manual = useRef({ height: 0, aileron: 0, elevator: 0 });
  const [reverse, setReverse] = useState<Reverse>(loadReverse);
  const reverseRef = useRef(reverse);
  reverseRef.current = reverse;
  const [trim, setTrim] = useState<Trim>(loadTrim);
  const trimRef = useRef(trim);
  trimRef.current = trim;
  const [autoHold, setAutoHold] = useState(loadAutoHold);
  const autoHoldRef = useRef(autoHold);
  autoHoldRef.current = autoHold;
  const armed = state?.armed === true;

  useEffect(() => {
    if (!connected) return;
    const beat = () => {
      const { height, aileron, elevator } = manual.current;
      const flip = reverseRef.current;
      const trimmed = trimRef.current;
      void Promise.resolve(invoke("drone_heartbeat", {
        input: {
          height,
          aileron: flip.aileron ? -aileron : aileron,
          elevator: flip.elevator ? -elevator : elevator,
          trimAileron: trimmed.aileron,
          trimElevator: trimmed.elevator,
          trimRudder: trimmed.rudder,
          autoHold: autoHoldRef.current,
        },
      })).catch(() => {});
    };
    const release = () => { manual.current = { height: 0, aileron: 0, elevator: 0 }; };
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

  // Arrow keys steer while armed. Another listener lands on Esc.
  useEffect(() => {
    if (!armed) return;
    const typing = (event: KeyboardEvent) => event.target instanceof HTMLElement
      && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));
    const down = (event: KeyboardEvent) => {
      const arrow = ARROWS[event.key];
      if (!arrow || typing(event)) return;
      event.preventDefault();
      manual.current = { ...manual.current, [arrow[0]]: arrow[1] * NUDGE };
    };
    const up = (event: KeyboardEvent) => {
      const arrow = ARROWS[event.key];
      if (arrow) manual.current = { ...manual.current, [arrow[0]]: 0 };
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      manual.current = { height: 0, aileron: 0, elevator: 0 };
    };
  }, [armed]);

  const flip = (axis: Axis) => {
    const next = { ...reverse, [axis]: !reverse[axis] };
    setReverse(next);
    save(REVERSE_KEY, JSON.stringify(next));
  };

  const nudgeTrim = (axis: keyof Trim, by: number) => {
    const next = { ...trim, [axis]: Math.max(-MAX_TRIM, Math.min(MAX_TRIM, trim[axis] + by)) };
    setTrim(next);
    save(TRIM_KEY, JSON.stringify(next));
  };

  const resetTrim = () => {
    setTrim(NO_TRIM);
    save(TRIM_KEY, JSON.stringify(NO_TRIM));
  };

  const toggleAutoHold = () => {
    setAutoHold(!autoHold);
    save(AUTO_HOLD_KEY, autoHold ? "off" : "on");
  };

  const trimRow = (label: string, axis: keyof Trim, lower: string, higher: string) => (
    <div className="flex items-center gap-2" role="group" aria-label={`${label} trim`}>
      <span style={{ minWidth: "5.5rem" }}>{label}</span>
      <Button variant="outline" aria-label={`Trim ${label.toLowerCase()} ${lower}`} onClick={() => nudgeTrim(axis, -1)}>−</Button>
      <span aria-live="polite" style={{ minWidth: "2.5rem", textAlign: "center" }}>{trim[axis] > 0 ? `+${trim[axis]}` : trim[axis]}</span>
      <Button variant="outline" aria-label={`Trim ${label.toLowerCase()} ${higher}`} onClick={() => nudgeTrim(axis, 1)}>+</Button>
    </div>
  );

  const holdButton = (label: string, axis: "height" | Axis, value: number) => (
    <Button
      variant="outline"
      disabled={!armed}
      onPointerDown={() => { manual.current = { ...manual.current, [axis]: value }; }}
      onPointerUp={() => { manual.current = { ...manual.current, [axis]: 0 }; }}
      onPointerLeave={() => { manual.current = { ...manual.current, [axis]: 0 }; }}
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
              {state.firmware && <>Firmware {state.firmware}. </>}Video {frameRate ?? "–"} frames a second, total {state.videoFrames}, skipped {state.videoSkipped}, damaged {state.videoDamaged}, restarts {state.videoRestarts}, repeats {state.videoRepeats}, unknown packets {state.unknownPackets}, commands sent {state.framesSent}, send errors {state.sendErrors}, watch {state.watchStreaming ? "streaming" : "not streaming"}
            </p>
          )}
          {state?.report && (
            <p className="subtitle" role="status" aria-label="Drone report">
              The drone reports fly state {state.report.flyState}, battery {state.report.battery} (raw, scale not yet known), speed {state.report.speed}{state.report.headless ? ", headless on" : ""}{state.report.light ? ", light on" : ""}. {state.statusMessages} {state.statusMessages === 1 ? "report" : "reports"} so far.
            </p>
          )}
          {state && state.unknownPackets > 0 && (
            <p className="subtitle" role="status">
              The drone sent {state.unknownPackets} {state.unknownPackets === 1 ? "packet" : "packets"} the app does not understand, possibly status or sensor data.
              {state.unknownPacketsFile ? <> The first 200 are saved in {state.unknownPacketsFile}.</> : null}
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
              content: "The app follows the picture the way a mouse follows a desk. The marker shows how far the view has moved since you pressed Set centre: green when the measure is trusted, red when the view is too blank or dark. Hold position works only once flying, and only after the picture has been steady for two seconds. It first pushes the drone sideways and forward and back, both ways, about nine seconds in all, to measure which way the sticks move the picture and how far, so keep a metre clear all round. Any break in the picture stops it at once, and steering by hand ends it. It then keeps the view where it was. Would send shows the corrections, which reach the drone only while hold is on.",
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
          <p className="subtitle">Hold position moves the drone sideways and forward and back while it measures. Keep a metre clear all round.</p>
          <div className="flex flex-wrap items-center gap-2">
            {state?.holding
              ? <Button variant="outline" onClick={() => runHold(false)}>Stop holding</Button>
              : <Button disabled={!state?.armed || !state?.tookOff} onClick={() => runHold(true)}>Hold position</Button>}
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
          <Button disabled={!state?.armed || state?.tookOff} onClick={() => run("drone_take_off")}>Take off</Button>
          {holdButton("Climb", "height", HEIGHT_RATE)}
          {holdButton("Descend", "height", -HEIGHT_RATE)}
          <Button variant="outline" disabled={!linked} onClick={() => run("drone_land")}>Land</Button>
          <Button variant="destructive" disabled={!linked} onClick={() => run("drone_stop")}>Stop</Button>
          {state?.flightLog && <p className="subtitle">Recording this flight to {state.flightLog}</p>}
        </CardContent>
        <CardContent className="flex flex-col gap-2" role="group" aria-label="Headless and return">
          <label>
            <input type="checkbox" checked={state?.headless ?? false} disabled={!connected} onChange={() => runMode("drone_set_headless", !state?.headless)} /> Headless mode
          </label>
          <p className="subtitle">In headless mode the drone steers by the direction it faced when the mode began, not by where its nose points, so point it away from you first. Sent only while armed; Stop turns it off.</p>
          <div className="flex flex-wrap items-center gap-2">
            {state?.returning
              ? <Button variant="outline" onClick={() => runMode("drone_set_return", false)}>Cancel return</Button>
              : confirmingReturn
                ? <>
                    <Button variant="destructive" onClick={() => { setConfirmingReturn(false); runMode("drone_set_return", true); }}>Confirm return</Button>
                    <Button variant="outline" onClick={() => setConfirmingReturn(false)}>Keep flying</Button>
                  </>
                : <Button variant="outline" disabled={!state?.armed || !state?.tookOff} onClick={() => setConfirmingReturn(true)}>Return home</Button>}
          </div>
          <p className="subtitle">
            {state?.returning
              ? "Returning. It ends by itself after 10 seconds, or with Cancel return, Land or Stop. Hold is off while it returns."
              : "The drone's advertised one-key return has never been tried from this app. With no GPS it can only fly back the way it faced at takeoff, and may not stop by itself, so use it only in open space with room behind it. It is sent for at most 10 seconds, and ends hold."}
          </p>
        </CardContent>
        <CardContent className="flex flex-col gap-2">
          <p className="subtitle">Steer with these buttons or the arrow keys. Steering ends hold. Which way each goes has not been checked on this drone, so nudge gently first and reverse it if needed.</p>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Steering">
            {holdButton("Left", "aileron", -NUDGE)}
            {holdButton("Forward", "elevator", NUDGE)}
            {holdButton("Back", "elevator", -NUDGE)}
            {holdButton("Right", "aileron", NUDGE)}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label><input type="checkbox" checked={reverse.aileron} onChange={() => flip("aileron")} /> Reverse left and right</label>
            <label><input type="checkbox" checked={reverse.elevator} onChange={() => flip("elevator")} /> Reverse forward and back</label>
          </div>
        </CardContent>
        <CardContent className="flex flex-col gap-2">
          <p className="subtitle">Trim cancels a drift the drone always has, so its own stabilising has less to fight. If it always slides one way after takeoff, nudge that axis the other way a step at a time. Trim is remembered, and works with hold and steering.</p>
          {trimRow("Sideways", "aileron", "left", "right")}
          {trimRow("Forward", "elevator", "back", "forward")}
          {trimRow("Turning", "rudder", "left", "right")}
          <div><Button variant="outline" onClick={resetTrim}>Reset trim</Button></div>
        </CardContent>
        <CardContent className="flex flex-col gap-2">
          <label><input type="checkbox" checked={autoHold} onChange={toggleAutoHold} /> Hold position after takeoff</label>
          <p className="subtitle">
            {state?.hasHoldCalibration
              ? "Three seconds after Take off, once the drone has finished its own climb, the app holds that spot using the saved measurement, with no test pushes."
              : "Needs one measurement first: take off in an open space and choose Hold position once. Its result is saved for later flights."}
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
