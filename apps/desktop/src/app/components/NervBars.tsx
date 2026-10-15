import { useEffect, useState, useSyncExternalStore } from "react";
import { getCameraController } from "../../features/camera/cameraService";
import { useThemeIs } from "../../shared/theme/useThemeIs";
import { NAV_LABELS, NAV_ORDER, type AppTab, type NavStatusInput } from "./AppNav";

const clockText = (at: Date) => at.toLocaleTimeString([], { hour12: false });

/** Ticks once a second, so the footer clock is the computer's real time. */
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

function HeaderBar({ activeTab }: { activeTab: AppTab }) {
  return (
    <header className="nerv-header" aria-label="System">
      <div className="nerv-header-id">
        <strong>SPATIAL GESTURE CONTROL</strong>
        <small>OPERATOR TERMINAL</small>
      </div>
      <div className="nerv-header-section" aria-live="polite">{sectionIdentifier(activeTab)}</div>
    </header>
  );
}

type Tone = "active" | "offline" | "unknown" | "caution";
const SYMBOL: Record<Tone, string> = { active: "●", offline: "○", unknown: "?", caution: "▲" };

function Item({ label, tone, text }: { label: string; tone: Tone; text: string }) {
  return (
    <li className="nerv-footer-item" data-tone={tone}>
      <span className="nerv-footer-label">{label}</span>
      <span className="nerv-footer-value">{SYMBOL[tone]} {text}</span>
    </li>
  );
}

function FooterBar({ headphonesConnected, watchConnected, watchWorn, recordingState }: NavStatusInput) {
  const camera = getCameraController();
  const cameraOn = useSyncExternalStore(camera.subscribe, () => camera.getSnapshot().status === "on", () => false);
  const now = useClock();
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
 * The NERV theme's top and bottom bars. The top bar names the system and the open page; the bottom bar shows which of the
 * headphones, watch, camera and recorder are live, and the computer's clock. Everything shown is read from the app's
 * own state: nothing is made up for effect. They exist only under the NERV theme.
 */
export function NervBars({ activeTab, ...status }: { activeTab: AppTab } & NavStatusInput) {
  const nerv = useThemeIs("nerv");
  if (!nerv) return null;
  return (
    <>
      <HeaderBar activeTab={activeTab} />
      <FooterBar {...status} />
    </>
  );
}
