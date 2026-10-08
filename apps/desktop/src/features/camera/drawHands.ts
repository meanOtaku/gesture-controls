import type { TrackedHand } from "./handTypes";

/** Which landmarks join: the palm and each finger. */
export const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

/** Draws the hands over a picture of `width` by `height`. Landmarks are 0 to 1 across the picture. */
export function drawHands(ctx: CanvasRenderingContext2D, hands: TrackedHand[], width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = Math.max(2, width / 320);
  for (const hand of hands) {
    ctx.strokeStyle = "#ff6f91";
    ctx.beginPath();
    for (const [a, b] of HAND_BONES) {
      const from = hand.image[a];
      const to = hand.image[b];
      if (!from || !to) continue;
      ctx.moveTo(from.x * width, from.y * height);
      ctx.lineTo(to.x * width, to.y * height);
    }
    ctx.stroke();
    ctx.fillStyle = "#ffd23f";
    for (const point of hand.image) {
      ctx.beginPath();
      ctx.arc(point.x * width, point.y * height, ctx.lineWidth * 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
