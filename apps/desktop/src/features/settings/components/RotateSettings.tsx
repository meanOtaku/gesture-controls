import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { RotateDirection } from "../../../shared/protocol/events";
import { SettingsNumberField } from "../settingsForm";

type RotateSettingsProps = {
  /** The most recent wrist twist recognised and how many there have been, to try the setting against. */
  lastRotate?: { direction: RotateDirection; count: number } | null;
};

/** How big a quick wrist twist must be to count as a rotate gesture, with a live readout to try it against. */
export function RotateSettings({ lastRotate = null }: RotateSettingsProps) {
  return (
    <Card role="region" aria-label="Rotate sensitivity">
      <CardHeader>
        <SectionHeader
          title="Rotate sensitivity"
          description="Wrist rotate gesture"
          help={{
            label: "About rotate",
            content: "A rotate is one quick twist of the wrist about your forearm, like turning a key: a set angle within about half a second, mostly about the forearm. A slow turn is the dial gesture instead, and swinging the whole arm does not count. The turn back after a flick is ignored for a moment so one flick fires once. Clockwise is as you see it looking along your forearm from the elbow towards the hand; if the two come out backwards, switch the wrist under Swipe sensitivity.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingsNumberField name="rotateAngleDegrees" />
        </div>
        <p className="field-hint" role="status" aria-live="polite">
          {lastRotate
            ? <>Last rotate recognised: <strong>{lastRotate.direction === "clockwise" ? "clockwise" : "counter-clockwise"}</strong> ({lastRotate.count} so far)</>
            : "No rotate recognised yet (needs the watch connected with its orientation sensor on)"}
        </p>
      </CardContent>
    </Card>
  );
}
