import { useEffect, useState, useSyncExternalStore } from "react";
import { getCameraController } from "../../features/camera/cameraService";
import { useThemeIs } from "../../shared/theme/useThemeIs";
import { NAV_LABELS, NAV_ORDER, type AppTab, type NavStatusInput } from "./AppNav";

const clockText = (at: Date) => at.toLocaleTimeString([], { hour12: false });

/** Ticks once a second, so the clocks show the computer's real time. */
function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** "05 // GESTURE LIBRARY": the page's place in the navigation order and its name. */
export function sectionIdentifier(tab: AppTab): string {
  const place = NAV_ORDER.indexOf(tab) + 1;
  return `${String(place).padStart(2, "0")} // ${NAV_LABELS[tab].toUpperCase()}`;
}

/*
 * A seven-segment display, like the show's "active time" clocks. Each digit is drawn on a 10 x 18 grid: three
 * horizontal segments (a top, g middle, d bottom) and four vertical ones (f and b upper left and right, e and c lower).
 * Unlit segments stay faintly visible, as on a real display.
 */
const H = (yc: number) => `1.6,${yc} 2.6,${yc - 1} 7.4,${yc - 1} 8.4,${yc} 7.4,${yc + 1} 2.6,${yc + 1}`;
const V = (xc: number, y0: number, y1: number) => `${xc},${y0 + 0.6} ${xc + 1},${y0 + 1.6} ${xc + 1},${y1 - 1.6} ${xc},${y1 - 0.6} ${xc - 1},${y1 - 1.6} ${xc - 1},${y0 + 1.6}`;
const SEGMENTS = { a: H(1), b: V(9, 1, 9), c: V(9, 9, 17), d: H(17), e: V(1, 9, 17), f: V(1, 1, 9), g: H(9) } as const;
type Segment = keyof typeof SEGMENTS;
const DIGIT_SEGMENTS: Record<string, Segment[]> = {
  "0": ["a", "b", "c", "d", "e", "f"], "1": ["b", "c"], "2": ["a", "b", "g", "e", "d"], "3": ["a", "b", "g", "c", "d"],
  "4": ["f", "g", "b", "c"], "5": ["a", "f", "g", "c", "d"], "6": ["a", "f", "g", "e", "c", "d"], "7": ["a", "b", "c"],
  "8": ["a", "b", "c", "d", "e", "f", "g"], "9": ["a", "b", "c", "d", "f", "g"],
};

function SevenSegment({ text }: { text: string }) {
  return (
    <span className="nerv-7seg" aria-hidden="true">
      {[...text].map((char, index) => char in DIGIT_SEGMENTS ? (
        <svg key={index} className="nerv-7seg-digit" viewBox="0 0 10 18">
          {(Object.keys(SEGMENTS) as Segment[]).map((segment) => (
            <polygon key={segment} points={SEGMENTS[segment]} data-on={DIGIT_SEGMENTS[char].includes(segment) || undefined} />
          ))}
        </svg>
      ) : (
        <svg key={index} className="nerv-7seg-colon" viewBox="0 0 4 18"><rect x="1" y="5" width="2" height="2" /><rect x="1" y="11" width="2" height="2" /></svg>
      ))}
    </span>
  );
}

type Tone = "active" | "offline" | "unknown" | "caution";
const SYMBOL: Record<Tone, string> = { active: "●", offline: "○", unknown: "?", caution: "▲" };

/** One device in the top bar's row of caution triangles: its short name and state, filled when live. */
function Unit({ name, tone, text }: { name: string; tone: Tone; text: string }) {
  return (
    <li className="nerv-unit" data-tone={tone} aria-label={`${name}: ${text}`}>
      <span className="nerv-unit-name">{name}</span>
      <span className="nerv-unit-state" aria-hidden="true">{SYMBOL[tone]} {text}</span>
    </li>
  );
}

type DeviceTones = { headphones: Tone; watch: Tone; camera: Tone; watchText: string };

function HeaderBar({ activeTab, devices, now }: { activeTab: AppTab; devices: DeviceTones; now: Date }) {
  const headText = devices.headphones === "active" ? "ONLINE" : "OFFLINE";
  const camText = devices.camera === "active" ? "ON" : "OFF";
  return (
    <header className="nerv-header" aria-label="System">
      <div className="nerv-header-id">
        <span className="nerv-header-mark" aria-hidden="true" />
        <div>
          <strong>SPATIAL GESTURE CONTROL</strong>
          <small>OPERATOR TERMINAL <span lang="ja" aria-hidden="true">空間ジェスチャー制御</span></small>
        </div>
      </div>
      {/* The frame crops the triangles at the bar's edges. */}
      <div className="nerv-units-frame">
        <ul className="nerv-units" aria-label="Devices">
          <Unit name="HEAD" tone={devices.headphones} text={headText} />
          <Unit name="WATCH" tone={devices.watch} text={devices.watchText} />
          <Unit name="CAM" tone={devices.camera} text={camText} />
        </ul>
      </div>
      {/* The computer's time on a seven-segment display; the bottom bar shows it instead when the window is too narrow. */}
      <div className="nerv-clock">
        <span className="nerv-clock-label" aria-hidden="true">ACTIVE TIME DISPLAY:</span>
        <time dateTime={now.toISOString()}><span className="sr-only">{clockText(now)}</span><SevenSegment text={clockText(now)} /></time>
      </div>
      {/* The live region stays put so the change is announced; the keyed span inside is remade each time so it slides in. */}
      <div className="nerv-header-section" aria-live="polite"><span key={activeTab}>{sectionIdentifier(activeTab)}</span></div>
    </header>
  );
}

function Item({ label, tone, text }: { label: string; tone: Tone; text: string }) {
  return (
    <li className="nerv-footer-item" data-tone={tone}>
      <span className="nerv-footer-label">{label}</span>
      <span className="nerv-footer-value">{SYMBOL[tone]} {text}</span>
    </li>
  );
}

function FooterBar({ headphonesConnected, watchConnected, watchWorn, recordingState, cameraOn, now }: NavStatusInput & { cameraOn: boolean; now: Date }) {
  const recording = recordingState === "recording" || recordingState === "arming";
  return (
    <footer className="nerv-footer" aria-label="System status">
      <ul>
        <Item label="HEADPHONES" tone={headphonesConnected ? "active" : "offline"} text={headphonesConnected ? "ONLINE" : "OFFLINE"} />
        <Item
          label="WATCH"
          tone={!watchConnected ? "offline" : watchWorn === false ? "caution" : "active"}
          text={!watchConnected ? "OFFLINE" : watchWorn === false ? "OFF WRIST" : "ONLINE"}
        />
        <Item label="CAMERA" tone={cameraOn ? "active" : "offline"} text={cameraOn ? "ON" : "OFF"} />
        <Item label="RECORDER" tone={recording ? "caution" : "offline"} text={recordingState === "arming" ? "ARMING" : recording ? "RECORDING" : "IDLE"} />
      </ul>
      <time className="nerv-footer-clock" dateTime={now.toISOString()}>{clockText(now)}</time>
    </footer>
  );
}

/**
 * The NERV theme's top and bottom bars. The top bar names the system and the open page, with a caution triangle per device; the bottom bar shows which of the
 * headphones, watch, camera and recorder are live, and the computer's clock. Everything shown is read from the app's
 * own state: nothing is made up for effect. They exist only under the NERV theme.
 */
export function NervBars({ activeTab, ...status }: { activeTab: AppTab } & NavStatusInput) {
  const nerv = useThemeIs("nerv");
  const camera = getCameraController();
  const cameraOn = useSyncExternalStore(camera.subscribe, () => camera.getSnapshot().status === "on", () => false);
  const now = useClock();
  if (!nerv) return null;
  const devices: DeviceTones = {
    headphones: status.headphonesConnected ? "active" : "offline",
    watch: !status.watchConnected ? "offline" : status.watchWorn === false ? "caution" : "active",
    watchText: !status.watchConnected ? "OFFLINE" : status.watchWorn === false ? "OFF WRIST" : "ONLINE",
    camera: cameraOn ? "active" : "offline",
  };
  return (
    <>
      <HeaderBar activeTab={activeTab} devices={devices} now={now} />
      <FooterBar {...status} cameraOn={cameraOn} now={now} />
    </>
  );
}
