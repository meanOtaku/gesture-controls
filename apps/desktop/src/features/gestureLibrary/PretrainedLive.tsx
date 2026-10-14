import { useEffect, useRef, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { getCameraController } from "../camera/cameraService";
import { pretrainedLabel, type PretrainedReading } from "../camera/pretrained";

const percent = (value: number) => `${Math.round(value * 100)}%`;
const REFRESH_MS = 100;

/** What MediaPipe's pretrained gesture recogniser says about the hand in view right now, from either camera. */
export function PretrainedLive() {
  const [reading, setReading] = useState<PretrainedReading | null>(null);
  const latest = useRef<PretrainedReading | null>(null);

  useEffect(() => {
    const take = (frame: { hands: { pretrained?: PretrainedReading }[] } | null) => {
      if (frame) latest.current = frame.hands.map((hand) => hand.pretrained).find((r) => r !== undefined) ?? null;
    };
    const stops = [getCameraController("primary"), getCameraController("secondary")].map((camera) => camera.subscribeFrames(take));
    // Shown a few times a second, not on every frame, so reading it never costs the camera any speed.
    const timer = window.setInterval(() => setReading((shown) => (shown?.gesture === latest.current?.gesture && Math.abs((shown?.score ?? 0) - (latest.current?.score ?? 0)) < 0.02 ? shown : latest.current)), REFRESH_MS);
    return () => {
      stops.forEach((stop) => stop());
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-2" role="status" aria-label="Pretrained model reading">
      <Badge variant={reading ? "default" : "secondary"}>{reading ? `${pretrainedLabel(reading.gesture)} · ${percent(reading.score)}` : "No known gesture"}</Badge>
      <span className="hint">What the pretrained model (closed fist, open palm, pointing up, thumb up, thumb down, victory, I love you) sees right now.</span>
    </div>
  );
}
