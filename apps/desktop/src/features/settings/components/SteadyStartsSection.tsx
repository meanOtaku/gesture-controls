import { SectionHeader } from "../../../components/app/SectionHeader";
import { AnimatedWord } from "../../../components/app/AnimatedNumber";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import type { ReadinessMotion } from "../../../shared/protocol/events";

/** The readiness light's choices for what counts as the wrist moving, the default first. */
export const READINESS_MOTION_CHOICES: { value: ReadinessMotion; label: string; detail: string }[] = [
  { value: "anyFastTurn", label: "Any fast turn", detail: "Warns after any fast turn of the wrist, a finger snap included." },
  {
    value: "ignoreShortJolts",
    label: "Ignore snaps and taps",
    detail: "Warns only when the wrist turns fast for longer than 0.4 s. A snap or a tap is shorter, and a pinch right after one is caught as well as with no snap.",
  },
  { value: "off", label: "Never", detail: "Never warns about motion; the light only shows whether the watch's signal can be read." },
];

type SteadyStartsSectionProps = {
  enabled: boolean;
  onToggle: () => void;
  /** The watch buzzes when the models can catch a gesture again after the wrist moved (or a stream dropped). */
  buzzWhenReady: boolean;
  onToggleBuzz: () => void;
  /** What the readiness light counts as the wrist moving. */
  readinessMotion: ReadinessMotion;
  onReadinessMotionChange: (motion: ReadinessMotion) => void;
};

/** The switch for only starting a trained model's gesture from a still hand. */
export function SteadyStartsSection({
  enabled,
  onToggle,
  buzzWhenReady,
  onToggleBuzz,
  readinessMotion,
  onReadinessMotionChange,
}: SteadyStartsSectionProps) {
  const motionChoice = READINESS_MOTION_CHOICES.find((choice) => choice.value === readinessMotion) ?? READINESS_MOTION_CHOICES[0];
  return (
    <Card role="region" aria-label="Still hand">
      <CardHeader>
        <SectionHeader
          title="Still hand"
          description="Only start a trained model's gesture when the hand was still just before it"
          help={{
            label: "About the still-hand rule",
            content:
              "Moving the arm, turning the wrist or typing buries the small jolt of a pinch and shifts the pulse sensor's level. With this on, a trained model's gesture only starts if the watch was still for the second before the gesture began (the motion's spread at most 0.4 m/s², turning at most 0.5 rad/s, tilt at most 10°); otherwise Model Lab's Activity says it was not started. A gesture already under way is never ended by it, and models trained while it is on learn only from such moments. It is off by default: on recordings where gestures follow each other with no pause, it blocks most of them. Record with a few seconds of stillness before each gesture before relying on it.",
          }}
        />
      </CardHeader>
      <CardContent>
        <div className="vector-row flex items-center justify-between gap-3">
          <span className="flex flex-col">
            <span className="label">Only start gestures from a still hand</span>
            <small className="text-xs text-muted-foreground">Applies to trained models, and to models trained from now on</small>
          </span>
          <span className="text-xs text-muted-foreground"><AnimatedWord>{enabled ? "On" : "Off"}</AnimatedWord></span>
          <Switch aria-label={`Only start gestures from a still hand ${enabled ? "on" : "off"}`} checked={enabled} onCheckedChange={onToggle} />
        </div>
        <div className="vector-row mt-2 flex items-center justify-between gap-3">
          <span className="flex flex-col">
            <span className="label">Buzz when ready after moving</span>
            <small className="text-xs text-muted-foreground">
              After the wrist moves, a pinch is caught reliably once it has been still for about a second. The sidebar shows when; this buzzes the watch too, for when the screen is out of view.
            </small>
          </span>
          <span className="text-xs text-muted-foreground"><AnimatedWord>{buzzWhenReady ? "On" : "Off"}</AnimatedWord></span>
          <Switch aria-label={`Buzz when ready after moving ${buzzWhenReady ? "on" : "off"}`} checked={buzzWhenReady} onCheckedChange={onToggleBuzz} />
        </div>
        <div className="vector-row mt-2 flex items-center justify-between gap-3">
          <span className="flex flex-col">
            <span className="label">Warn that the wrist is moving</span>
            <small className="text-xs text-muted-foreground">
              What the sidebar's readiness light counts as moving. {motionChoice.detail} Detection itself is the same whatever you choose.
            </small>
          </span>
          <Select
            value={readinessMotion}
            onValueChange={(value) => {
              if (value) onReadinessMotionChange(value as ReadinessMotion);
            }}
          >
            <SelectTrigger aria-label="Warn that the wrist is moving" className="w-48 shrink-0">
              <SelectValue>{motionChoice.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {READINESS_MOTION_CHOICES.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}
