import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";
import { CONTROLLABLE_SENSORS, IMU_SENSOR_IDS, type WatchStatus } from "../../../shared/protocol/events";

type WatchSensorControlsProps = {
  watchStatus: WatchStatus | null;
  isPending: (key: string) => boolean;
  onSetSensorEnabled: (sensor: string, enabled: boolean) => void;
};

/** Per-sensor enable/disable switches for the Watch's IMU and continuous medical trackers. */
export function WatchSensorControls({ watchStatus, isPending, onSetSensorEnabled }: WatchSensorControlsProps) {
  return (
    <Card role="region" aria-label="Watch sensor controls">
      <CardHeader>
        <div className="flex items-center gap-2">
          <SectionHeader title="Sensor controls" description="Desktop control" />
          <HelpTooltip label="About sensor controls">
            Disabling a sensor stops the Watch from sampling and sending that stream, which can help save
            battery. IMU sensors (orientation, accelerometer, gyroscope) resume immediately when re-enabled;
            continuous medical trackers may take a moment to reconnect.
          </HelpTooltip>
        </div>
      </CardHeader>
      <CardContent>
        <div className="vectors">
          {CONTROLLABLE_SENSORS.map(({ id, label }) => {
            const enabled = IMU_SENSOR_IDS.has(id)
              ? watchStatus?.sensorStatus?.[id] ?? true
              : watchStatus?.medicalStatus?.[id] !== "idle";
            const pending = isPending(`sensor:${id}`);
            return (
              <div className="vector-row sensor-toggle-row" key={id}>
                <span className="label">{label}</span>
                <span>{pending ? "Updating…" : enabled ? "Enabled" : "Disabled"}</span>
                <Switch
                  aria-label={`${label} ${enabled ? "enabled" : "disabled"}`}
                  checked={enabled}
                  disabled={!watchStatus?.connected || pending}
                  onCheckedChange={(checked) => onSetSensorEnabled(id, checked)}
                />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
