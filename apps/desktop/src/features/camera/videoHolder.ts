/**
 * A camera's video element has to stay in the document, or the browser pauses it and the hand detector stops getting
 * pictures (a recording would lose its camera data whenever you are on another tab). Pages borrow the element to show it;
 * when a page closes, the element is parked here, out of sight, instead of being removed.
 */
let holder: HTMLDivElement | null = null;

function ensureHolder(): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  if (holder && holder.isConnected) return holder;
  const div = document.createElement("div");
  div.setAttribute("aria-hidden", "true");
  div.setAttribute("data-camera-holder", "");
  Object.assign(div.style, { position: "fixed", right: "0", bottom: "0", width: "2px", height: "2px", overflow: "hidden", opacity: "0", pointerEvents: "none" });
  document.body.appendChild(div);
  holder = div;
  return div;
}

/** Keeps the video in the document, out of sight. */
export function parkVideo(video: HTMLVideoElement): void {
  video.className = "";
  ensureHolder()?.appendChild(video);
}

/** Starts a video that was paused when it was moved, if it has a picture to play. */
export function resumeVideo(video: HTMLVideoElement): void {
  if (video.srcObject && video.paused && typeof video.play === "function") void Promise.resolve(video.play()).catch(() => undefined);
}
