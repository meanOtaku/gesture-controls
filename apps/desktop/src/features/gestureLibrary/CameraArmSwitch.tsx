import { invoke } from "@tauri-apps/api/core";
import { useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { getCameraController } from "../camera/cameraService";

/**
 * The master switch for recipes that use a camera gesture. Off at every start and off again whenever the camera stops, so
 * a recipe never acts on the camera unless you switched it on in this run, with the camera running. The desktop keeps
 * the state; this only asks it.
 */
export function CameraArmSwitch({ armed }: { armed: boolean }) {
  const camera = getCameraController();
  const cam = useSyncExternalStore(camera.subscribe, camera.getSnapshot, camera.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const camOn = cam.status === "on";

  const change = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await invoke("set_camera_armed", { armed: next });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3" role="group" aria-label="Camera gestures">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <strong className="text-sm">Camera gestures {armed ? "armed" : "off"}</strong>
          <small className="text-xs text-muted-foreground">
            {armed
              ? "Recipes with a camera gesture can act now. Switch it off to stop them; it also switches off by itself if the camera stops."
              : camOn
                ? "Recipes with a camera gesture will not act until you arm this."
                : "Turn the camera on to arm. Recipes with a camera gesture will not act until then."}
          </small>
        </div>
        <div className="flex items-center gap-3">
          {!camOn && !armed && <Button type="button" variant="outline" size="sm" disabled={cam.status === "starting"} onClick={() => void camera.enable()}>{cam.status === "starting" ? "Starting…" : "Turn camera on"}</Button>}
          <Switch aria-label="Arm camera gestures" checked={armed} disabled={busy || (!armed && !camOn)} onCheckedChange={(checked) => void change(checked === true)} />
        </div>
      </div>
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
    </div>
  );
}
