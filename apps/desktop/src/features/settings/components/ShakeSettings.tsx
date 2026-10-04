import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SettingsNumberField } from "../settingsForm";

/** How easily a shake of the wrist is recognised, with a live count so the setting can be tried straight away. */
export function ShakeSettings({ detections = 0 }: { detections?: number }) {
  return (
    <Card role="region" aria-label="Shake sensitivity">
      <CardHeader>
        <SectionHeader
          title="Shake sensitivity"
          description="Wrist shake gesture"
          help={{
            label: "About shake sensitivity",
            content: "A shake is a quick back-and-forth of the wrist, seen in the watch's acceleration. Lower the strength, or ask for fewer strokes, if your shakes are missed; raise them if ordinary movement sets it off. Apply, then shake: the counter below goes up each time one is recognised.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingsNumberField name="shakePeakThreshold" />
          <SettingsNumberField name="shakeStrokes" />
        </div>
        <p className="field-hint" role="status" aria-live="polite">
          Shakes recognised since you opened the app: <strong>{detections}</strong>
          {detections === 0 && " (needs the watch connected with its acceleration sensor on)"}
        </p>
      </CardContent>
    </Card>
  );
}
