import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { NumericSettingKey } from "../settingsFields";
import { SettingsNumberField } from "../settingsForm";

/** Every built-in gesture's strength setting, in the order the gestures are listed above. */
const FIELDS: NumericSettingKey[] = [
  "shakePeakThreshold",
  "shakeStrokes",
  "wigglePeakRate",
  "hammerPeakThreshold",
  "swipePeakThreshold",
  "tapPeakThreshold",
  "rollAngleDegrees",
  "pitchAngleDegrees",
];

/**
 * How strong each built-in gesture has to be, in one card. Each field says its range and default; whether a setting
 * works is tried on the Gestures page, which lights each gesture up as it is recognised.
 */
export function SensitivitySection() {
  return (
    <Card role="region" aria-label="Gesture sensitivity">
      <CardHeader>
        <SectionHeader
          title="Sensitivity"
          description="Lower catches gentler gestures, and more accidents. Apply, then try it on the Gestures page."
          help={{
            label: "About gesture sensitivity",
            content:
              "Shake: quick strokes back and forth; strength is how hard each is, strokes how many make one. Wiggle: quick twists of the wrist; speed is how fast it turns at the top of each. Hammer: the fist brought down on the other palm, or a clap. Swipe: one quick push of the hand. Tap: a knock on the watch while the arm is still. Roll and pitch: a quick twist about the forearm, or a nod at the wrist, through at least the set angle. If left and right, or clockwise and counter-clockwise, come out backwards, check Watch orientation.",
          }}
        />
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {FIELDS.map((name) => <SettingsNumberField key={name} name={name} />)}
      </CardContent>
    </Card>
  );
}
