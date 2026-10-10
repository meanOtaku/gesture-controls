import { useSyncExternalStore } from "react";
import { Checkbox } from "../../components/ui/checkbox";
import type { CameraSnapshot } from "../camera/cameraController";
import { handsSwapped, physicalHand, setHandsSwapped, subscribeHandsSwapped } from "../camera/handTypes";

/**
 * Says which hand the app thinks the camera sees, live, and lets you correct it. Cameras and the hand model do not all
 * agree on which side is left, so raise your left hand: if this says Right, tick the box.
 */
export function HandSideCheck({ camera, secondary }: { camera: CameraSnapshot; secondary?: CameraSnapshot }) {
  const swapped = useSyncExternalStore(subscribeHandsSwapped, handsSwapped, handsSwapped);
  const hands = camera.frame?.hands ?? [];
  const describe = (list: typeof hands) => (list.length === 0 ? "no hand in view" : list.map((hand) => `${physicalHand(hand)} hand`).join(" and "));
  const second = secondary?.status === "on" ? secondary.frame?.hands ?? [] : null;
  const seen = second === null ? describe(hands) : `first camera: ${describe(hands)}; second camera: ${describe(second)}`;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm" role="group" aria-label="Which hand the camera sees">
      <span role="status">The app sees: <strong>{seen}</strong>. Raise your left hand to check.</span>
      <label className="flex items-center gap-2">
        <Checkbox checked={swapped} onCheckedChange={(checked) => setHandsSwapped(checked === true)} aria-label="Left and right are swapped" />
        <span>Left and right are swapped</span>
      </label>
    </div>
  );
}
