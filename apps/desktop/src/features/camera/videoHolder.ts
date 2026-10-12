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

/** Where each video is being shown, oldest first: the newest is the one showing it. */
const owners = new WeakMap<HTMLVideoElement, HTMLElement[]>();

/**
 * Shows `video` at the start of `host` until the returned function is called. Several places can show the same camera (a
 * page and the quick preview, say); the newest shows it, and when it lets go the video goes back to the newest place still
 * showing it, or is parked when there is none.
 */
export function showVideo(video: HTMLVideoElement, host: HTMLElement, className = "camera-video"): () => void {
  const stack = owners.get(video) ?? [];
  owners.set(video, [...stack.filter((h) => h !== host), host]);
  video.className = className;
  host.prepend(video);
  resumeVideo(video);
  return () => {
    const remaining = (owners.get(video) ?? []).filter((h) => h !== host);
    owners.set(video, remaining);
    if (video.parentElement !== host) return; // someone newer is showing it
    const previous = remaining.at(-1);
    if (previous && previous.isConnected) {
      video.className = className;
      previous.prepend(video);
      resumeVideo(video);
    } else {
      parkVideo(video);
    }
  };
}

/** Starts a video that was paused when it was moved, if it has a picture to play. */
export function resumeVideo(video: HTMLVideoElement): void {
  if (video.srcObject && video.paused && typeof video.play === "function") void Promise.resolve(video.play()).catch(() => undefined);
}
