import { CameraProposalsPanel } from "../../gestureLibrary/CameraProposalsPanel";
import { RawImageViewerPanel } from "./RawImageViewerPanel";

/** Your saved recordings. For now this is the raw image viewer; reviewing and relabelling sessions will live here too. */
export function RecordingsPage() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  return <main className="shell telemetry-shell">
    <header className="hero">
      <div><p className="eyebrow">Spatial Gesture Control</p><h1>Recordings</h1><p className="subtitle">Look inside the sessions you have saved.</p></div>
    </header>
    {desktopAvailable ? (
      <>
        <CameraProposalsPanel />
        <RawImageViewerPanel />
      </>
    ) : (
      <p className="hint">Saved recordings live in the desktop app's data directory, so they are unavailable in browser preview.</p>
    )}
  </main>;
}
