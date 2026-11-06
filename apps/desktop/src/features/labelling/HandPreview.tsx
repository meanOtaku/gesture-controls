import { createPortal } from "react-dom";
import { HandPreviewTarget } from "../../shared/HandPreviewTarget";
import { useContext, useEffect, useRef, useState } from "react";
import { drawHands } from "../camera/drawHands";
import type { TrackedHand } from "../camera/handTypes";

const WIDTH = 160;
const HEIGHT = 120;

/** What the camera saw at the cursor: the hands' landmarks, drawn as the camera pictured them. */
export function HandPreview({ hands, atLabel }: { hands: TrackedHand[] | null; atLabel: string }) {
  const target = useContext(HandPreviewTarget);
  const [wide, setWide] = useState(() => window.matchMedia?.("(min-width: 1101px)").matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.("(min-width: 1101px)");
    if (!media) return;
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const sidebar = target && wide;
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext?.("2d");
    if (!element || !context) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = WIDTH * ratio;
    element.height = HEIGHT * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (hands && hands.length > 0) drawHands(context, hands, WIDTH, HEIGHT);
    else context.clearRect(0, 0, WIDTH, HEIGHT);
  }, [hands, sidebar]);
  const preview = (
    <figure className="labelling-hand" aria-label="Camera at the cursor">
      <canvas ref={canvas} style={{ width: WIDTH, height: HEIGHT }} role="img" aria-label={hands && hands.length > 0 ? `The hands at ${atLabel}` : "No hand at the cursor"} />
      <figcaption>{hands === null ? "No frame here" : hands.length === 0 ? "No hand in view" : atLabel}</figcaption>
    </figure>
  );
  return sidebar ? createPortal(
    <section className="nerv-module" aria-label="Hand preview">
      <header><span>04 / HAND PREVIEW</span></header>
      {preview}
    </section>, target,
  ) : preview;
}
