import { useEffect, useRef } from "react";
import type { CameraController, CameraSnapshot } from "../cameraController";
import { drawHands } from "../drawHands";

/**
 * The camera's picture in a mirror view with the hand landmarks drawn on it. The video element belongs to the camera,
 * not to this component: it is shown here while the page is open and handed back when it closes.
 */
export function CameraPreview({ camera, state, hidden }: { camera: CameraController; state: CameraSnapshot; hidden: boolean }) {
  const stage = useRef<HTMLDivElement | null>(null);
  const overlay = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    camera.video.className = "camera-video";
    host.prepend(camera.video);
    return () => {
      camera.video.remove();
    };
  }, [camera]);

  useEffect(() => {
    const canvas = overlay.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const width = camera.video.videoWidth || 640;
    const height = camera.video.videoHeight || 360;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    drawHands(context, state.frame?.hands ?? [], width, height);
  }, [camera, state.frame]);

  return (
    <div className="camera-stage" ref={stage} hidden={hidden} style={{ aspectRatio: `${camera.video.videoWidth || 16} / ${camera.video.videoHeight || 9}` }}>
      <canvas ref={overlay} className="camera-overlay" aria-label="Hand landmarks" />
    </div>
  );
}
