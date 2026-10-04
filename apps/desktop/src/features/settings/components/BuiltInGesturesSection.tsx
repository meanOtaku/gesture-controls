import { SectionHeader } from "../../../components/app/SectionHeader";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";
import type { HeuristicGesture, HeuristicGestures } from "../../../shared/protocol/events";

export const BUILT_IN_GESTURES: ReadonlyArray<{ id: HeuristicGesture; label: string; detail: string }> = [
  { id: "shake", label: "Shake", detail: "A quick back-and-forth of the wrist" },
  { id: "swipe", label: "Swipe", detail: "One quick push of the hand: left, right, up or down" },
  { id: "tap", label: "Tap", detail: "A knock on the watch, single or double" },
  { id: "roll", label: "Roll", detail: "A quick twist of the wrist about the forearm" },
  { id: "pitch", label: "Pitch", detail: "A quick nod of the hand up or down at the wrist" },
];

type BuiltInGesturesSectionProps = {
  gestures: HeuristicGestures;
  onToggle: (gesture: HeuristicGesture) => void;
};

/** Switches for the rule-based wrist gestures. Off means it is never recognised, so a recipe using it never fires. */
export function BuiltInGesturesSection({ gestures, onToggle }: BuiltInGesturesSectionProps) {
  return (
    <Card role="region" aria-label="Built-in gestures">
      <CardHeader>
        <SectionHeader
          title="Built-in gestures"
          description="Rule-based wrist gestures"
          help={{
            label: "About built-in gestures",
            content: "These gestures are recognised by fixed rules on the watch's motion sensors. Switch one off to stop it being recognised, for example once a model you trained handles that gesture better. Recipes that use an off gesture stay saved but never fire, and say so. A pinch and the STEM button are not on this list.",
          }}
        />
      </CardHeader>
      <CardContent>
        <div className="vectors">
          {BUILT_IN_GESTURES.map(({ id, label, detail }) => {
            const enabled = gestures[id] ?? true;
            return (
              <div className="vector-row flex items-center justify-between gap-3" key={id}>
                <span className="flex flex-col">
                  <span className="label">{label}</span>
                  <small className="text-xs text-muted-foreground">{detail}</small>
                </span>
                <span className="text-xs text-muted-foreground">{enabled ? "On" : "Off"}</span>
                <Switch
                  aria-label={`${label} gesture ${enabled ? "on" : "off"}`}
                  checked={enabled}
                  onCheckedChange={() => onToggle(id)}
                />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
