import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatedText } from "../../../components/app/AnimatedNumber";
import type { HeadTrackerStatus, PpgState, WatchStatus } from "../../../shared/protocol/events";
import { useThemeIs } from "../../../shared/theme/useThemeIs";
import { droneDevice, firmwareVersion, getDroneSnapshot, subscribeDrone, type DroneStatus } from "../../drone/droneStatus";

const COLLAPSED_KEY = "nervTelemetryCollapsed";
const MAX_LOG = 8;
const SEGMENTS = 10;

type Tone = "active" | "offline" | "unknown" | "caution";
const TAGS: Record<Tone, string> = { active: "● ACTIVE", offline: "○ OFFLINE", unknown: "? UNKNOWN", caution: "▲ CAUTION" };

/** A state with its symbol and words, so colour is never the only signal. */
function StatusTag({ tone, text }: { tone: Tone; text?: string }) {
  return <span className="nerv-tag" data-tone={tone}>{text ?? TAGS[tone]}</span>;
}

function Row({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="nerv-row">
      <span className="nerv-row-label">{label}</span>
      <span className="nerv-row-value"><AnimatedText>{value}</AnimatedText>{unit ? <small>{unit}</small> : null}</span>
    </div>
  );
}

/** A segmented bar for a real percentage: ten cells, each a tenth. */
function SegmentBar({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * SEGMENTS);
  return (
    <div className="nerv-seg" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)}>
      {Array.from({ length: SEGMENTS }, (_, i) => <span key={i} data-on={i < filled ? "true" : "false"} data-low={clamped < 20 ? "true" : "false"} />)}
    </div>
  );
}

const fixed = (value: number, digits: number) => value.toFixed(digits);
const PPG_WORDS: Record<PpgState, string> = {
  idle: "IDLE",
  permission_required: "PERMISSION NEEDED",
  connecting: "CONNECTING",
  streaming: "STREAMING",
  unavailable: "UNAVAILABLE",
  error: "ERROR",
};

interface LogLine {
  id: number;
  at: Date;
  text: string;
}
const clock = (at: Date) => at.toLocaleTimeString([], { hour12: false });

/** A timestamped list of the changes seen while the panel has been open: nothing is invented, and nothing before it opened is shown. */
function useEventLog(headConnected: boolean, watchConnected: boolean, worn: boolean | null, ppg: PpgState | null, drone: string): LogLine[] {
  const [lines, setLines] = useState<LogLine[]>(() => [{ id: 0, at: new Date(), text: "TELEMETRY ONLINE" }]);
  const previous = useRef({ headConnected, watchConnected, worn, ppg, drone });
  const next = useRef(1);
  useEffect(() => {
    const was = previous.current;
    const added: string[] = [];
    if (was.headConnected !== headConnected) added.push(headConnected ? "HEADPHONES CONNECTED" : "HEADPHONES LOST");
    if (was.watchConnected !== watchConnected) added.push(watchConnected ? "WATCH CONNECTED" : "WATCH LOST");
    if (was.worn !== worn && worn !== null) added.push(worn ? "WATCH ON WRIST" : "WATCH OFF WRIST");
    if (was.ppg !== ppg && ppg !== null) added.push(`PPG ${PPG_WORDS[ppg]}`);
    if (was.drone !== drone) added.push(`DRONE ${drone}`);
    previous.current = { headConnected, watchConnected, worn, ppg, drone };
    if (added.length === 0) return;
    const at = new Date();
    setLines((current) => [...added.map((text) => ({ id: next.current++, at, text })).reverse(), ...current].slice(0, MAX_LOG));
  }, [headConnected, watchConnected, worn, ppg, drone]);
  return lines;
}

const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;

/** Only what the drone link really measures. The drone reports no battery or height, so neither is shown. */
function DroneModule({ status }: { status: DroneStatus | null }) {
  const device = droneDevice(status);
  const live = status?.phase === "open";
  const trust = status?.flow ? status.flow.confidence * 100 : null;
  return (
    <section className="nerv-module" aria-label="Drone">
      <header><span>03 / DRONE</span><StatusTag tone={device.tone} text={device.tone === "offline" ? undefined : `${TAGS[device.tone].slice(0, 1)} ${device.text}`} /></header>
      {live && status ? (
        <>
          {status.firmware && <Row label="FIRMWARE" value={firmwareVersion(status.firmware) ?? "—"} />}
          <Row label="ARMED" value={status.armed ? "▲ YES" : "○ NO"} />
          <Row label="HOLD" value={status.holding ? "▲ ON" : "○ OFF"} />
          <Row label="VIDEO" value={status.videoRate !== null ? String(status.videoRate) : "—"} unit={status.videoRate !== null ? " /s" : undefined} />
          <Row label="TRACKING" value={trust !== null ? String(Math.round(trust)) : "—"} unit={trust !== null ? "%" : undefined} />
          {trust !== null && <SegmentBar percent={trust} label="Tracking agreement" />}
          <Row label="DRIFT X" value={fixed(status.driftX, 1)} unit=" px" />
          <Row label="DRIFT Y" value={fixed(status.driftY, 1)} unit=" px" />
          <Row label="CORRECTION" value={status.correction ? `${signed(status.correction.aileron)} / ${signed(status.correction.elevator)}` : "—"} />
          <Row label="SKIPPED" value={String(status.videoSkipped)} />
          <Row label="SEND ERRORS" value={String(status.sendErrors)} />
        </>
      ) : (
        <p className="nerv-empty">NO SIGNAL</p>
      )}
    </section>
  );
}

type PanelProps = { headStatus: HeadTrackerStatus | null; watchStatus: WatchStatus | null; handPreviewRef?: (element: HTMLDivElement | null) => void };

function Panel({ headStatus, watchStatus, handPreviewRef }: PanelProps) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // The panel still opens and closes; it is just not remembered.
    }
  };

  const headConnected = headStatus?.connected === true;
  const watchConnected = watchStatus?.connected === true;
  const worn = watchStatus?.worn ?? null;
  const droneStatus = useSyncExternalStore(subscribeDrone, getDroneSnapshot, () => null);
  const log = useEventLog(headConnected, watchConnected, worn, watchStatus?.ppgState ?? null, droneDevice(droneStatus).text);

  if (collapsed) {
    return (
      <aside className="nerv-telemetry" data-collapsed="true" aria-label="Telemetry">
        <button type="button" className="nerv-telemetry-toggle" aria-expanded={false} onClick={toggle}>◂ TELEMETRY</button>
      </aside>
    );
  }

  const battery = watchStatus?.lastHeartbeat?.batteryPercent ?? null;
  const heart = watchStatus?.heartRateLast?.heartRate;
  const skin = watchStatus?.skinTemperatureLast?.objectTemperatureCelsius;
  return (
    <aside className="nerv-telemetry" aria-label="Telemetry">
      <div className="nerv-telemetry-head">
        <h2>Telemetry</h2>
        <button type="button" className="nerv-telemetry-toggle" aria-expanded onClick={toggle} aria-label="Collapse telemetry">▸</button>
      </div>

      <section className="nerv-module" aria-label="Headphones">
        <header><span>01 / HEADPHONES</span><StatusTag tone={headConnected ? "active" : "offline"} /></header>
        {headConnected && headStatus ? (
          <>
            <Row label="DEVICE" value={headStatus.device ?? "UNKNOWN"} />
            <Row label="YAW" value={fixed(headStatus.yawDeg, 1)} unit="°" />
            <Row label="PITCH" value={fixed(headStatus.pitchDeg, 1)} unit="°" />
            <Row label="ROLL" value={fixed(headStatus.rollDeg, 1)} unit="°" />
            <Row label="PACKETS" value={fixed(headStatus.packetsPerSecond, 1)} unit=" /s" />
            <Row label="LATENCY" value={fixed(headStatus.receiveLatencyMs, 1)} unit=" ms" />
          </>
        ) : (
          <p className="nerv-empty">NO SIGNAL</p>
        )}
      </section>

      <section className="nerv-module" aria-label="Watch">
        <header><span>02 / WATCH</span><StatusTag tone={watchConnected ? "active" : "offline"} /></header>
        {watchConnected && watchStatus ? (
          <>
            <Row label="ON WRIST" value={worn === true ? "● WORN" : worn === false ? "○ NOT WORN" : "? UNKNOWN"} />
            <Row label="BATTERY" value={battery !== null ? String(Math.round(battery)) : "—"} unit={battery !== null ? "%" : undefined} />
            {battery !== null && <SegmentBar percent={battery} label="Watch battery" />}
            <Row label="PPG" value={watchStatus.ppgState ? PPG_WORDS[watchStatus.ppgState] : "—"} />
            {watchStatus.ppgRateHz != null && <Row label="PPG RATE" value={fixed(watchStatus.ppgRateHz, 1)} unit=" Hz" />}
            {heart != null && heart > 0 && <Row label="HEART RATE" value={String(Math.round(heart))} unit=" bpm" />}
            {skin != null && <Row label="SKIN TEMP" value={fixed(skin, 1)} unit=" °C" />}
            {watchStatus.roundTripNs != null && <Row label="ROUND TRIP" value={fixed(watchStatus.roundTripNs / 1_000_000, 1)} unit=" ms" />}
          </>
        ) : (
          <p className="nerv-empty">NO SIGNAL</p>
        )}
      </section>

      <DroneModule status={droneStatus} />

      <section className="nerv-module" aria-label="Event log">
        <header><span>04 / EVENT LOG</span></header>
        <ol className="nerv-log">
          {log.map((line) => (
            <li key={line.id}><time dateTime={line.at.toISOString()}>{clock(line.at)}</time> {line.text}</li>
          ))}
        </ol>
      </section>
      {handPreviewRef && <div ref={handPreviewRef} className="nerv-hand-preview-slot" />}
    </aside>
  );
}

/**
 * The NERV theme's right-hand telemetry panel: the headphones', the watch's and the drone's live readings while connected
 * (otherwise "no signal", never a made-up number), and a log of the changes seen since it opened. It exists only under
 * the NERV theme, can be collapsed (remembered), and gives way on narrow windows.
 */
export function NervTelemetryPanel(props: PanelProps) {
  return useThemeIs("nerv") ? <Panel {...props} /> : null;
}
