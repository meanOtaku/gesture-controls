import { useEffect, useRef } from "react";
import type { CameraController, CameraSnapshot } from "../cameraController";
import type { HandFrame } from "../handTypes";
import { drawHands } from "../drawHands";
import { showVideo } from "../videoHolder";

/**
 * The camera's picture in a mirror view with the hand landmarks drawn on it. The video element belongs to the camera,
 * not to this component: it is shown here while the page is open, handed back to any other preview still open when it
 * closes, and otherwise parked out of sight, never removed from the document (a removed video is paused, and the hand
 * detector would stop).
 */
export function CameraPreview({ camera, state, hidden }: { camera: CameraController; state: CameraSnapshot; hidden: boolean }) {
  const stage = useRef<HTMLDivElement | null>(null);
  const overlay = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    return showVideo(camera.video, host);
  }, [camera]);

  // The landmarks are drawn from the camera's own frame stream, at the camera's rate, not through page rendering, so the
  // drawing stays with the picture even when the page is busy.
  useEffect(() => {
    const canvas = overlay.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const draw = (frame: HandFrame | null) => {
      const width = camera.video.videoWidth || 640;
      const height = camera.video.videoHeight || 360;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      drawHands(context, frame?.hands ?? [], width, height);
    };
    draw(camera.getSnapshot?.().frame ?? state.frame);
    return camera.subscribeFrames?.(draw);
  }, [camera, state.status]);

  return (
    <div className="camera-stage" ref={stage} hidden={hidden} style={{ aspectRatio: `${camera.video.videoWidth || 16} / ${camera.video.videoHeight || 9}` }}>
      <canvas ref={overlay} className="camera-overlay" aria-label="Hand landmarks" />
    </div>
  );
}
