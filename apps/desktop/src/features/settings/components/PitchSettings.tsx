import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { PitchDirection } from "../../../shared/protocol/events";
import { SettingsNumberField } from "../settingsForm";

type PitchSettingsProps = {
  /** The most recent tilt of the hand recognised and how many there have been, to try the setting against. */
  lastPitch?: { direction: PitchDirection; count: number } | null;
};

/** How big a quick tilt of the hand must be to count as a pitch gesture, with a live readout to try it against. */
export function PitchSettings({ lastPitch = null }: PitchSettingsProps) {
  return (
    <Card role="region" aria-label="Pitch sensitivity">
      <CardHeader>
        <SectionHeader
          title="Pitch sensitivity"
          description="Hand pitch gesture"
          help={{
            label: "About pitch",
            content: "A pitch is one quick nod of the hand at the wrist, up or down, like a stop sign or a wave: a set angle within about half a second, mostly about the axis across your wrist. A slow tilt is the dial gesture instead, and swinging the whole arm does not count. The nod back is ignored for a moment so one nod fires once. Which way is up depends on Watch orientation; if up and down come out backwards, check it.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingsNumberField name="pitchAngleDegrees" />
        </div>
        <p className="field-hint" role="status" aria-live="polite">
          {lastPitch
            ? <>Last pitch recognised: <strong>{lastPitch.direction}</strong> ({lastPitch.count} so far)</>
            : "No pitch recognised yet (needs the watch connected with its orientation sensor on)"}
        </p>
      </CardContent>
    </Card>
  );
}
