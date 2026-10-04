import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { SwipeDirection } from "../../../shared/protocol/events";
import { SettingsNumberField } from "../settingsForm";

type SwipeSettingsProps = {
  /** The most recent swipe recognised and how many there have been, to try the setting against. */
  lastSwipe?: { direction: SwipeDirection; count: number } | null;
};

/** How easily a swipe of the hand is recognised, with a live readout to try it against. */
export function SwipeSettings({ lastSwipe = null }: SwipeSettingsProps) {
  return (
    <Card role="region" aria-label="Swipe sensitivity">
      <CardHeader>
        <SectionHeader
          title="Swipe sensitivity"
          description="Hand swipe gesture"
          help={{
            label: "About swipes",
            content: "A swipe is one quick push of the hand. Left and right run along your forearm, so set the crown side under Watch orientation; up and down follow gravity. Lower the strength if swipes are missed, raise it if ordinary movement sets one off. Swipe, and the readout below shows what was recognised.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SettingsNumberField name="swipePeakThreshold" />
        </div>
        <p className="field-hint" role="status" aria-live="polite">
          {lastSwipe
            ? <>Last swipe recognised: <strong>{lastSwipe.direction}</strong> ({lastSwipe.count} so far)</>
            : "No swipe recognised yet (needs the watch connected with its acceleration and orientation sensors on)"}
        </p>
      </CardContent>
    </Card>
  );
}
