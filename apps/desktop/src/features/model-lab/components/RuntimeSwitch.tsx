import { useId, useState } from "react";
import { SegmentedControl } from "../../../components/app/SegmentedControl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { MODE_OPTIONS, type LabelRuntimeMode } from "../labelModels";
import { setRuntimeMode, useRuntimeMode } from "../runtimeMode";

const SUMMARY: Record<LabelRuntimeMode, string> = {
  off: "No model runs",
  monitor: "Watching only; nothing acts",
  live: "Detections can start recipes",
};

/**
 * Off, Monitor or Live for the trained models, from anywhere: the sidebar has one and Model Lab's overview has one, and
 * both show the same mode. Going Live asks first, since then a detection can start a recipe.
 */
export function RuntimeSwitch({ variant }: { variant: "sidebar" | "page" }) {
  const labelId = useId();
  const { mode, blocked, pending, error } = useRuntimeMode();
  const [confirmLive, setConfirmLive] = useState(false);
  if (!("__TAURI_INTERNALS__" in window)) return null;

  const choose = (next: LabelRuntimeMode) => {
    if (next === "live" && mode !== "live") setConfirmLive(true);
    else void setRuntimeMode(next);
  };

  return (
    <div className={`runtime-switch runtime-switch-${variant}${variant === "sidebar" ? " group-data-[collapsible=icon]:hidden" : ""}`} data-mode={mode ?? "unknown"}>
      <span id={labelId} className="runtime-switch-label">{variant === "sidebar" ? "Models" : "Runtime"}</span>
      <SegmentedControl
        labelledBy={labelId}
        value={mode ?? "off"}
        disabled={mode === null || pending || blocked}
        options={MODE_OPTIONS.map(({ value, label }) => ({ value, label }))}
        onValueChange={choose}
      />
      {variant === "page" && <small role="status">{mode ? SUMMARY[mode] : "Asking the runtime…"}. A restart comes back in Monitor.</small>}
      {error && <small className="text-destructive" role="alert">{error}</small>}
      <AlertDialog open={confirmLive} onOpenChange={setConfirmLive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Let models drive recipes?</AlertDialogTitle>
            <AlertDialogDescription>
              In Live, a detection from an active model can start any recipe that uses its label (volume, brightness,
              scroll, media keys). Check the models in Monitor first. A restart always comes back in Monitor, never Live.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay in {mode ?? "off"}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void setRuntimeMode("live")}>Switch to Live</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
