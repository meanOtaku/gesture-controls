import { SectionHeader } from "../../../components/app/SectionHeader";
import { SegmentedControl } from "../../../components/app/SegmentedControl";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { SwipeDirection, WatchWrist } from "../../../shared/protocol/events";
import { SettingsNumberField } from "../settingsForm";

type SwipeSettingsProps = {
  wrist: WatchWrist;
  onWristChange: (wrist: WatchWrist) => void;
  /** The most recent swipe recognised and how many there have been, to try the setting against. */
  lastSwipe?: { direction: SwipeDirection; count: number } | null;
};

const WRISTS = [
  { value: "left", label: "Left wrist" },
  { value: "right", label: "Right wrist" },
] as const;

/** How easily a swipe of the hand is recognised, which wrist the watch is on, and a live readout to try it against. */
export function SwipeSettings({ wrist, onWristChange, lastSwipe = null }: SwipeSettingsProps) {
  return (
    <Card role="region" aria-label="Swipe sensitivity">
      <CardHeader>
        <SectionHeader
          title="Swipe sensitivity"
          description="Hand swipe gesture"
          help={{
            label: "About swipes",
            content: "A swipe is one quick push of the hand. Left and right run along your forearm, so tell the app which wrist the watch is on; up and down follow gravity. Lower the strength if swipes are missed, raise it if ordinary movement sets one off. Swipe, and the readout below shows what was recognised.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="field">
          <div className="field-head"><span id="swipe-wrist-label" className="field-label">Watch worn on</span></div>
          <SegmentedControl labelledBy="swipe-wrist-label" value={wrist} onValueChange={onWristChange} options={WRISTS} />
          <p className="field-hint">Decides which way along your forearm counts as left. If left and right come out backwards, switch this.</p>
        </div>
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
