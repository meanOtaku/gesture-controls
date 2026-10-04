import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { TapKind } from "../../../shared/protocol/events";
import { SettingsNumberField } from "../settingsForm";

type TapSettingsProps = {
  /** The most recent tap recognised and how many there have been, to try the setting against. */
  lastTap?: { kind: TapKind; count: number } | null;
};

/** How easily a knock on the watch is recognised, with a live readout to try it against. */
export function TapSettings({ lastTap = null }: TapSettingsProps) {
  return (
    <Card role="region" aria-label="Tap sensitivity">
      <CardHeader>
        <SectionHeader
          title="Tap sensitivity"
          description="Tap and double-tap gestures"
          help={{
            label: "About taps",
            content: "A tap is a knock of a finger on the watch's screen or case: one brief, sharp jolt into the screen while your arm is otherwise still. Two quick knocks make a double tap. A single tap is reported about 0.4 seconds after the knock, once it is clear no second one is coming. Lower the strength if taps are missed, raise it if bumps set it off.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingsNumberField name="tapPeakThreshold" />
        </div>
        <p className="field-hint" role="status" aria-live="polite">
          {lastTap
            ? <>Last tap recognised: <strong>{lastTap.kind === "double" ? "double tap" : "tap"}</strong> ({lastTap.count} so far)</>
            : "No tap recognised yet (needs the watch connected with its acceleration and orientation sensors on)"}
        </p>
      </CardContent>
    </Card>
  );
}
