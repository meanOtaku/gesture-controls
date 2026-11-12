import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { HelpTooltip } from "../../components/app/HelpTooltip";
import { Button } from "../../components/ui/button";
import { getCameraController } from "../camera/cameraService";
import { appNavigation } from "../../shared/navigation/appNavigation";
import { markMiss, MISS_FAILED_EVENT, MISS_SAVED_EVENT, type MissKind, type MissSaved } from "./missApi";
import { attachMissCamera, followCamera, MissCameraBuffer } from "./missCamera";

/** The saved recording is 45 s long and ends at the mark; open it a little before its end, where the miss was. */
const OPEN_AT_MS = 35_000;

const inDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** What the camera part of a saved miss came to, as one sentence for the notification. */
export type CameraOutcome = "saved" | "off" | "failed";
export const CAMERA_LINE: Record<CameraOutcome, string> = {
  saved: "The camera's view of your hand is saved with it: open it in Labelling to see the hand at each moment.",
  off: "The camera was off (or saw nothing it could time), so there is no picture of the hand. Turn the camera on to have one next time.",
  failed: "The camera's view of your hand could not be saved with it.",
};

function announce(saved: MissSaved, camera: CameraOutcome): void {
  toast.success(saved.name, {
    description: (
      <ul className="miss-summary">
        {saved.summary.lines.map((line) => <li key={line}>{line}</li>)}
        <li>{CAMERA_LINE[camera]}</li>
      </ul>
    ),
    duration: 15_000,
    action: {
      label: "Open in Labelling",
      onClick: () => appNavigation.openInLabelling({ datasetId: saved.datasetId, atMs: OPEN_AT_MS }),
    },
  });
}

/**
 * Keeps what the camera saw lately, and when a miss is saved (by a button here or the key that works in any app) saves
 * that with it and says what the models did. Mounted once, for as long as the app is open.
 */
export function useMissFollowUp(): void {
  const desktop = inDesktop();
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const buffer = new MissCameraBuffer();
    const stops: (() => void)[] = [followCamera(getCameraController(), buffer)];
    const follow = <T,>(event: string, show: (payload: T) => void) => {
      void Promise.resolve(listen<T>(event, ({ payload }) => { if (!disposed) show(payload); }))
        .then((stop) => { if (disposed) stop?.(); else if (stop) stops.push(stop); })
        .catch(() => undefined);
    };
    follow<MissSaved>(MISS_SAVED_EVENT, (saved) => {
      const files = buffer.files(performance.now());
      if (files === null) {
        announce(saved, "off");
        return;
      }
      attachMissCamera(saved.datasetId, files)
        .then(() => announce(saved, "saved"))
        .catch(() => announce(saved, "failed"));
    });
    follow<string>(MISS_FAILED_EVENT, (why) => toast.error("The miss was not saved", { description: why }));
    return () => { disposed = true; stops.forEach((stop) => stop()); };
  }, [desktop]);
}

/** The two buttons that mark a miss. A saved miss is announced by its event, so the key and the buttons say it the same way. */
export function MissButtons({ className }: { className?: string }) {
  const [saving, setSaving] = useState<MissKind | null>(null);
  if (!inDesktop()) return null;
  const mark = (kind: MissKind) => {
    setSaving(kind);
    markMiss(kind)
      .catch((error: unknown) => toast.error("The miss was not saved", { description: String(error) }))
      .finally(() => setSaving(null));
  };
  return (
    <div className={className ?? "miss-marker-buttons"}>
      <Button size="sm" variant="outline" disabled={saving !== null} onClick={() => mark("missed")}>
        {saving === "missed" ? "Saving…" : "It didn't fire"}
      </Button>
      <Button size="sm" variant="outline" disabled={saving !== null} onClick={() => mark("falseActivation")}>
        {saving === "falseActivation" ? "Saving…" : "It fired by itself"}
      </Button>
    </div>
  );
}

/**
 * "That was wrong", in the sidebar: saves the last 45 seconds of the watch's signals with what the models did in them,
 * and what the camera saw of the hand if it was on, and says why nothing (or something) fired.
 */
export function MissMarker() {
  useMissFollowUp();
  if (!inDesktop()) return null;
  return (
    <div className="miss-marker group-data-[collapsible=icon]:hidden" role="group" aria-label="Mark a miss">
      <span className="miss-marker-title">
        That was wrong
        <HelpTooltip label="About marking a miss">
          Saves the last 45 seconds of the watch's signals as a recording under “Misses” in Datasets, with what the models
          scored and why nothing fired. If the camera is on, what it saw of your hand is saved too, so you can check what
          really happened. Use it right after a gesture goes wrong. From any other app, press Ctrl+Alt+M (Control-Option-M
          on a Mac).
        </HelpTooltip>
      </span>
      <MissButtons />
    </div>
  );
}
