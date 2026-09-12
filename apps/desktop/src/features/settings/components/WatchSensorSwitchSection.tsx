import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";
import { CONTROLLABLE_SENSORS } from "../../../shared/protocol/events";

type WatchSensorSwitchSectionProps = {
  watchSensorsEnabled: Record<string, boolean>;
  onToggle: (id: string) => void;
};

/** Default enabled/disabled state applied to each Watch sensor whenever it reconnects. */
export function WatchSensorSwitchSection({ watchSensorsEnabled, onToggle }: WatchSensorSwitchSectionProps) {
  return (
    <Card role="region" aria-label="Watch sensor enable switches">
      <CardHeader>
        <div className="flex items-center gap-2">
          <SectionHeader title="Sensor switches" description="Galaxy Watch" />
          <HelpTooltip label="About sensor switches">
            Sets each sensor's default enabled state for the next time the Watch connects. To change a
            currently-streaming sensor immediately, use the switch on the device's own Dashboard tab instead.
          </HelpTooltip>
        </div>
      </CardHeader>
      <CardContent>
        <div className="vectors">
          {CONTROLLABLE_SENSORS.map(({ id, label }) => {
            const enabled = watchSensorsEnabled[id] ?? true;
            return (
              <div className="vector-row sensor-toggle-row" key={id}>
                <span className="label">{label}</span>
                <span>{enabled ? "Enabled" : "Disabled"}</span>
                <Switch
                  aria-label={`${label} ${enabled ? "enabled" : "disabled"} by default`}
                  checked={enabled}
                  onCheckedChange={() => onToggle(id)}
                />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
