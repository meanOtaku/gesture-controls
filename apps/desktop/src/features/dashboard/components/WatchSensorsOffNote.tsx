import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { appNavigation } from "../../../shared/navigation/appNavigation";
import { CONTROLLABLE_SENSORS, IMU_SENSOR_IDS, type WatchStatus } from "../../../shared/protocol/events";

/** The pulse sensor's id; its on/off shows in the Watch's pulse status, not a sensor status of its own. */
const PULSE_SENSOR_ID = "ppg_continuous";
/** What the gesture models read: with any of these off they cannot score. */
const MODEL_SENSORS = new Set(["acceleration", "gyroscope", PULSE_SENSOR_ID]);

/** The names of the sensors the connected watch reports as off. */
export function sensorsOff(watchStatus: WatchStatus | null): { id: string; label: string }[] {
  if (!watchStatus?.connected) return [];
  return CONTROLLABLE_SENSORS.filter(({ id }) =>
    IMU_SENSOR_IDS.has(id)
      ? watchStatus.sensorStatus?.[id] === false
      : id === PULSE_SENSOR_ID
        ? watchStatus.ppgState === "idle"
        : watchStatus.medicalStatus?.[id] === "idle",
  );
}

/**
 * The sensors that are off, said in one line, with the way to Settings → Watch where they are switched. Nothing shows
 * while every sensor streams. (The switches themselves live only in Settings, which keeps them across reconnects.)
 */
export function WatchSensorsOffNote({ watchStatus }: { watchStatus: WatchStatus | null }) {
  const off = sensorsOff(watchStatus);
  if (off.length === 0) return null;
  const blocksModels = off.some(({ id }) => MODEL_SENSORS.has(id));
  return (
    <Card role="region" aria-label="Sensors that are off">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">
          <strong>Off:</strong> {off.map(({ label }) => label).join(", ")}.
          {blocksModels ? " Gesture models read the pulse sensor and the motion sensors, so they cannot score." : ""}
        </span>
        <Button type="button" variant="outline" onClick={() => appNavigation.open("settings")}>Change in Settings</Button>
      </CardContent>
    </Card>
  );
}
