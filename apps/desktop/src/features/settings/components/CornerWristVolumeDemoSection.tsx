import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";

type CornerWristVolumeDemoSectionProps = {
  enabled: boolean;
  invertDirection: boolean;
  onToggleEnabled: () => void;
  onToggleInvertDirection: () => void;
};

/**
 * Demo-only opt-in: while enabled, dwelling on the calibrated top-right
 * target grabs the volume overlay directly (no STEM button) and wrist twists
 * adjust volume until the target is left, the tracker/Watch drops, or Escape
 * is pressed. Off by default; the Watch-button and desktop-model grab paths
 * are unaffected either way.
 */
export function CornerWristVolumeDemoSection({
  enabled,
  invertDirection,
  onToggleEnabled,
  onToggleInvertDirection,
}: CornerWristVolumeDemoSectionProps) {
  return (
    <Card role="region" aria-label="Corner wrist volume demo settings">
      <CardHeader>
        <div className="flex items-center gap-2">
          <SectionHeader title="Corner wrist volume (demo)" description="Gaze + wrist demo interaction" />
          <HelpTooltip label="About the corner wrist volume demo">
            Dwelling on the calibrated top-right target grabs the volume overlay directly, then a clockwise wrist
            twist raises volume and a counter-clockwise twist lowers it. Leaving the target, losing the tracker or
            Watch, or pressing Escape stops it immediately. The Watch-button and gesture-model volume paths keep
            working exactly as before, regardless of this setting.
          </HelpTooltip>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <span className="label">Enable demo interaction</span>
          <Switch
            aria-label={`Corner wrist volume demo ${enabled ? "enabled" : "disabled"}`}
            checked={enabled}
            onCheckedChange={onToggleEnabled}
          />
        </div>
        {enabled && (
          <div className="flex items-center justify-between gap-3">
            <span className="label">Invert twist direction</span>
            <Switch
              aria-label={`Corner wrist volume direction ${invertDirection ? "inverted" : "not inverted"}`}
              checked={invertDirection}
              onCheckedChange={onToggleInvertDirection}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
