import { SectionHeader } from "../../../components/app/SectionHeader";
import { SegmentedControl } from "../../../components/app/SegmentedControl";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { CrownSide, WatchWrist } from "../../../shared/protocol/events";

type WatchOrientationSettingsProps = {
  crownSide: CrownSide;
  wrist: WatchWrist;
  onCrownSideChange: (crownSide: CrownSide) => void;
  onWristChange: (wrist: WatchWrist) => void;
};

const CROWN_SIDES = [
  { value: "right", label: "Crown on the right" },
  { value: "left", label: "Crown on the left" },
] as const;

const WRISTS = [
  { value: "left", label: "Left wrist" },
  { value: "right", label: "Right wrist" },
] as const;

/** How the watch sits on the arm, so left and right (swipes) and clockwise (roll) mean what they say. */
export function WatchOrientationSettings({ crownSide, wrist, onCrownSideChange, onWristChange }: WatchOrientationSettingsProps) {
  return (
    <Card role="region" aria-label="Watch orientation">
      <CardHeader>
        <SectionHeader
          title="Watch orientation"
          description="Left, right and clockwise"
          help={{
            label: "About watch orientation",
            content: "The watch senses movement in its own frame, so the app has to know how it sits on you. Read the watch face as you normally do: the crown is on its right or on its left. That decides which way a swipe along your arm is left or right. Which wrist the watch is on matters only for a roll: clockwise is the way you turn a screwdriver, looking along your forearm from the elbow to the hand, and that differs between wrists.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="field">
          <div className="field-head"><span id="crown-side-label" className="field-label">Crown side</span></div>
          <SegmentedControl labelledBy="crown-side-label" value={crownSide} onValueChange={onCrownSideChange} options={CROWN_SIDES} />
          <p className="field-hint">As you read the watch face. Most people wear it with the crown on the right. If swipes left and right come out backwards, switch this.</p>
        </div>
        <div className="field">
          <div className="field-head"><span id="watch-wrist-label" className="field-label">Watch worn on</span></div>
          <SegmentedControl labelledBy="watch-wrist-label" value={wrist} onValueChange={onWristChange} options={WRISTS} />
          <p className="field-hint">Only the roll gesture uses this. If clockwise and counter-clockwise come out backwards after the crown side is right, switch this.</p>
        </div>
      </CardContent>
    </Card>
  );
}
