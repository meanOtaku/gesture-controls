import { Command } from "cmdk";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { getCameraController } from "../../features/camera/cameraService";
import { markMiss, type MissKind } from "../../features/misses/missApi";
import { NAV_LABELS, NAV_ORDER, shortcutFor, type AppTab } from "./AppNav";

const inDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Everything the app can go to or do, found by typing: Cmd/Ctrl+K opens it from anywhere, including a text field. Pages are
 * listed in the menu's order; the actions are the ones worth reaching without finding their page first (marking a miss,
 * the camera, the list of keyboard shortcuts).
 */
export function CommandPalette({ onSelect }: { onSelect: (tab: AppTab) => void }) {
  const [open, setOpen] = useState(false);
  const camera = getCameraController();
  const cameraOn = useSyncExternalStore(camera.subscribe, () => camera.getSnapshot().status === "on", () => false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        setOpen((now) => !now);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  const miss = (kind: MissKind) =>
    run(() => { markMiss(kind).catch((error: unknown) => toast.error("The miss was not saved", { description: String(error) })); });

  return (
    <Command.Dialog open={open} onOpenChange={setOpen} label="Go to a page or do something" className="command-palette" overlayClassName="command-palette-overlay">
      <Command.Input placeholder="Go to a page, or do something…" />
      <Command.List>
        <Command.Empty>Nothing matches. Try a page's name, “miss” or “camera”.</Command.Empty>
        <Command.Group heading="Go to">
          {NAV_ORDER.map((tab) => (
            <Command.Item key={tab} value={`go ${NAV_LABELS[tab]}`} onSelect={() => run(() => onSelect(tab))}>
              <span>{NAV_LABELS[tab]}</span>
              {shortcutFor(tab) && <kbd>{shortcutFor(tab)}</kbd>}
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group heading="Do">
          {inDesktop() && (
            <>
              <Command.Item value="mark a miss: it didn't fire" onSelect={() => miss("missed")}>
                <span>Mark a miss: it didn't fire</span>
              </Command.Item>
              <Command.Item value="mark a miss: it fired by itself" onSelect={() => miss("falseActivation")}>
                <span>Mark a miss: it fired by itself</span>
              </Command.Item>
            </>
          )}
          <Command.Item value={cameraOn ? "turn the camera off" : "turn the camera on"} onSelect={() => run(() => (cameraOn ? camera.disable() : void camera.enable()))}>
            <span>{cameraOn ? "Turn the camera off" : "Turn the camera on"}</span>
          </Command.Item>
          <Command.Item value="show keyboard shortcuts" onSelect={() => run(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })))}>
            <span>Show keyboard shortcuts</span>
            <kbd>?</kbd>
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
