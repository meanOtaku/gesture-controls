import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";
import type { AutomationState, CalibrationState, Recipe, RecipeStage } from "../../../shared/protocol/events";

type RecipesCardProps = {
  automation: AutomationState;
  calibration: CalibrationState | null;
  isPending: (key: string) => boolean;
  onSetRecipeEnabled: (id: string, enabled: boolean) => void;
};

const AXIS_LABEL = { roll: "Roll", pitch: "Pitch", yaw: "Yaw" } as const;
const DEVICE_LABEL: Record<string, string> = {
  rotationKnob: "rotation knob",
  horizontalFader: "horizontal fader",
  verticalFader: "vertical fader",
  stepKnob: "step knob",
};

function stageLabel(stage: RecipeStage, locationName: (id: string) => string): string {
  switch (stage.kind) {
    case "headAt":
      return `Look at ${locationName(stage.location)}`;
    case "hold":
      return stage.hold === "pinch" ? "Pinch and hold" : "Hold STEM button";
    case "drive":
      return `${AXIS_LABEL[stage.axis]} wrist`;
  }
}

/** "Look at Top right → Pinch and hold → Roll wrist → rotation knob → Volume" */
export function describeRecipe(recipe: Recipe, locationName: (id: string) => string): string {
  return [
    ...recipe.stages.map((stage) => stageLabel(stage, locationName)),
    DEVICE_LABEL[recipe.device.kind] ?? recipe.device.kind,
    "Volume",
  ].join(" → ");
}

/** The gesture recipes: what each does, whether it is on, and which ones are in conflict and so held off. */
export function RecipesCard({ automation, calibration, isPending, onSetRecipeEnabled }: RecipesCardProps) {
  const nameOfRecipe = (id: string) => automation.recipes.find((recipe) => recipe.id === id)?.name ?? id;
  const locationName = (id: string) => calibration?.targets.find((location) => location.id === id)?.name ?? "a removed location";

  return (
    <Card role="region" aria-label="Gesture recipes">
      <CardHeader>
        <SectionHeader
          title="Gesture recipes"
          description="What your gestures control"
          help={{
            label: "About gesture recipes",
            content: "A recipe chains gestures: every step before the last must hold for the wrist rotation to move the volume. Two recipes that control the same thing cannot both be on, so both are paused until you switch one off.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {automation.conflicts.map((conflict) => (
          <Alert key={`${conflict.first}:${conflict.second}`} variant="destructive">
            <AlertTitle>These gestures are fighting over {conflict.resource}</AlertTitle>
            <AlertDescription>
              “{nameOfRecipe(conflict.first)}” and “{nameOfRecipe(conflict.second)}” both control {conflict.resource}, so
              neither will work. Switch one of them off.
            </AlertDescription>
          </Alert>
        ))}
        <ul className="flex flex-col gap-3" aria-label="Recipes">
          {automation.recipes.map((recipe) => {
            const blocked = automation.blocked.includes(recipe.id);
            const pending = isPending(`recipe:${recipe.id}`);
            return (
              <li key={recipe.id} className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm">
                    {recipe.name} {blocked && <Badge variant="destructive">Paused: conflict</Badge>}
                  </span>
                  <small className="text-xs text-muted-foreground">{describeRecipe(recipe, locationName)}</small>
                </div>
                <Switch
                  aria-label={`${recipe.name} ${recipe.enabled ? "on" : "off"}`}
                  checked={recipe.enabled}
                  disabled={pending}
                  onCheckedChange={(checked) => onSetRecipeEnabled(recipe.id, checked)}
                />
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
