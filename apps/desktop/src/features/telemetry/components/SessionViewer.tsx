import { CameraProposalsPanel } from "../../gestureLibrary/CameraProposalsPanel";
import { RawImageViewerPanel } from "./RawImageViewerPanel";

/**
 * A look inside one saved session: its signals as images, and the camera's proposals for label intervals. It sits folded
 * at the foot of the Recordings page (it was a page of its own). Saved sessions live in the desktop app's data
 * directory, so it shows nothing in the browser preview.
 */
export function SessionViewer() {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  return (
    <>
      <CameraProposalsPanel />
      <RawImageViewerPanel />
    </>
  );
}
