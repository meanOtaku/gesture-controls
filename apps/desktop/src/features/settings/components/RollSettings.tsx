import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { RollDirection } from "../../../shared/protocol/events";
import { SettingsNumberField } from "../settingsForm";

type RollSettingsProps = {
  /** The most recent wrist twist recognised and how many there have been, to try the setting against. */
  lastRoll?: { direction: RollDirection; count: number } | null;
};

/** How big a quick wrist twist must be to count as a roll gesture, with a live readout to try it against. */
export function RollSettings({ lastRoll = null }: RollSettingsProps) {
  return (
    <Card role="region" aria-label="Roll sensitivity">
      <CardHeader>
        <SectionHeader
          title="Roll sensitivity"
          description="Wrist roll gesture"
          help={{
            label: "About roll",
            content: "A roll is one quick twist of the wrist about your forearm, like turning a key: a set angle within about half a second, mostly about the forearm. A slow turn is the dial gesture instead, and swinging the whole arm does not count. The turn back after a flick is ignored for a moment so one flick fires once. Clockwise is as you see it looking along your forearm from the elbow towards the hand; if the two come out backwards, check Watch orientation.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingsNumberField name="rollAngleDegrees" />
        </div>
        <p className="field-hint" role="status" aria-live="polite">
          {lastRoll
            ? <>Last roll recognised: <strong>{lastRoll.direction === "clockwise" ? "clockwise" : "counter-clockwise"}</strong> ({lastRoll.count} so far)</>
            : "No roll recognised yet (needs the watch connected with its orientation sensor on)"}
        </p>
      </CardContent>
    </Card>
  );
}
