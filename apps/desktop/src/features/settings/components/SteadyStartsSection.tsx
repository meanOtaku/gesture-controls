import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";

type SteadyStartsSectionProps = {
  enabled: boolean;
  onToggle: () => void;
};

/** The switch for only starting a trained model's gesture from a still hand. */
export function SteadyStartsSection({ enabled, onToggle }: SteadyStartsSectionProps) {
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
          <span className="text-xs text-muted-foreground">{enabled ? "On" : "Off"}</span>
          <Switch aria-label={`Only start gestures from a still hand ${enabled ? "on" : "off"}`} checked={enabled} onCheckedChange={onToggle} />
        </div>
      </CardContent>
    </Card>
  );
}
