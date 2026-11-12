import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { HelpTooltip } from "../../components/app/HelpTooltip";
import { Button } from "../../components/ui/button";
import { appNavigation } from "../../shared/navigation/appNavigation";
import { markMiss, MISS_FAILED_EVENT, MISS_SAVED_EVENT, type MissKind, type MissSaved } from "./missApi";

/** The saved recording is 45 s long and ends at the mark; open it a little before its end, where the miss was. */
const OPEN_AT_MS = 35_000;

function announce(saved: MissSaved): void {
  toast.success(saved.name, {
    description: (
      <ul className="miss-summary">
        {saved.summary.lines.map((line) => <li key={line}>{line}</li>)}
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
 * "That was wrong": saves the last 45 seconds of the watch's signals with what the models did in them, and says why
 * nothing (or something) fired. The same happens from the key that works in any app; either way the result is shown here.
 */
export function MissMarker() {
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [saving, setSaving] = useState<MissKind | null>(null);

  useEffect(() => {
    if (!inTauri) return;
    let disposed = false;
    const stops: (() => void)[] = [];
    const follow = <T,>(event: string, show: (payload: T) => void) => {
      void Promise.resolve(listen<T>(event, ({ payload }) => { if (!disposed) show(payload); }))
        .then((stop) => { if (disposed) stop?.(); else if (stop) stops.push(stop); })
        .catch(() => undefined);
    };
    follow<MissSaved>(MISS_SAVED_EVENT, announce);
    follow<string>(MISS_FAILED_EVENT, (why) => toast.error("The miss was not saved", { description: why }));
    return () => { disposed = true; stops.forEach((stop) => stop()); };
  }, [inTauri]);

  if (!inTauri) return null;

  const mark = (kind: MissKind) => {
    setSaving(kind);
    // A saved miss is announced by its event, so the key and the buttons say it the same way.
    markMiss(kind)
      .catch((error: unknown) => toast.error("The miss was not saved", { description: String(error) }))
      .finally(() => setSaving(null));
  };

  return (
    <div className="miss-marker group-data-[collapsible=icon]:hidden" role="group" aria-label="Mark a miss">
      <span className="miss-marker-title">
        That was wrong
        <HelpTooltip label="About marking a miss">
          Saves the last 45 seconds of the watch's signals as a recording under “Misses” in Datasets, with what the models
          scored and why nothing fired. Use it right after a gesture goes wrong. From any other app, press Ctrl+Alt+M
          (Control-Option-M on a Mac).
        </HelpTooltip>
      </span>
      <div className="miss-marker-buttons">
        <Button size="sm" variant="outline" disabled={saving !== null} onClick={() => mark("missed")}>
          {saving === "missed" ? "Saving…" : "It didn't fire"}
        </Button>
        <Button size="sm" variant="outline" disabled={saving !== null} onClick={() => mark("falseActivation")}>
          {saving === "falseActivation" ? "Saving…" : "It fired by itself"}
        </Button>
      </div>
    </div>
  );
}
