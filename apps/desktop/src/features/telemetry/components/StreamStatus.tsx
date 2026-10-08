import { useSyncExternalStore } from "react";
import { telemetryStore } from "../store/telemetryStore";

/** Whether the headphones and the watch are connected, shown at the top of the capture pages. */
export function StreamStatus() {
  useSyncExternalStore(telemetryStore.subscribe, telemetryStore.getVersion, telemetryStore.getVersion);
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const headConnected = telemetryStore.getHeadStatus()?.connected === true;
  const watchConnected = telemetryStore.getWatchStatus()?.connected === true;
  return (
    <div className="stream-status" aria-label="Sensor connections">
      <span><i className={headConnected ? "connected" : ""} />Headphones · {headConnected ? "Connected" : "Disconnected"}</span>
      <span><i className={watchConnected ? "connected" : ""} />Watch · {watchConnected ? "Connected" : "Disconnected"}</span>
      {!desktopAvailable && <span className="preview-label">Browser preview · connect devices in the desktop app</span>}
    </div>
  );
}
