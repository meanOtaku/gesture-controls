import { SectionHeader } from "../../../components/app/SectionHeader";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";
import type { AutomationState, CalibrationState } from "../../../shared/protocol/events";
import { ConflictAlerts } from "../../recipes/components/ConflictAlerts";
import { MissButtons } from "../../misses/MissMarker";
import { describeRecipe } from "../../recipes/recipeModel";
import { useRecipeActivity } from "../../recipes/useRecipeActivity";

const clock = (at: Date) => at.toLocaleTimeString([], { hour12: false });
const MOMENT = { started: "started", ended: "let go", fired: "fired" } as const;

type RecipesCardProps = {
  automation: AutomationState;
  calibration: CalibrationState | null;
  isPending: (key: string) => boolean;
  onSetRecipeEnabled: (id: string, enabled: boolean) => void;
};

/** The gesture recipes: what each does, whether it is on, and which ones are in conflict and so held off. */
export function RecipesCard({ automation, calibration, isPending, onSetRecipeEnabled }: RecipesCardProps) {
  const locationName = (id: string) => calibration?.targets.find((location) => location.id === id)?.name ?? "a removed location";
  const activity = useRecipeActivity();
  const recipeName = (id: string) => automation.recipes.find((recipe) => recipe.id === id)?.name ?? "A removed recipe";

  return (
    <Card role="region" aria-label="Gesture recipes">
      <CardHeader>
        <SectionHeader
          title="Gesture recipes"
          description="What your gestures control, and what they are doing right now"
          help={{
            label: "About gesture recipes",
            content: "A recipe chains gestures: every step before the last must hold for the wrist rotation to move the volume. Two recipes that control the same thing cannot both be on, so both are paused until you switch one off.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ConflictAlerts automation={automation} />
        <ul className="flex flex-col gap-3" aria-label="Recipes">
          {automation.recipes.map((recipe) => {
            const blocked = automation.blocked.includes(recipe.id);
            const pending = isPending(`recipe:${recipe.id}`);
            const use = activity.byRecipe.get(recipe.id);
            return (
              <li key={recipe.id} className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm">
                    {recipe.name} {blocked && <Badge variant="destructive">Paused: conflict</Badge>}
                    {use?.inUse && <Badge>In use</Badge>}
                  </span>
                  <small className="text-xs text-muted-foreground">{describeRecipe(recipe, locationName)}</small>
                  {use && use.uses > 0 && use.lastAt && (
                    <small className="text-xs text-muted-foreground">Used {use.uses} time{use.uses === 1 ? "" : "s"} this session, last at {clock(use.lastAt)}.</small>
                  )}
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
        <div className="flex flex-col gap-2" role="group" aria-label="Recent use">
          <strong className="text-sm">Just now</strong>
          {activity.recent.length === 0 ? (
            <p className="field-hint">Nothing yet this session. When a recipe starts, lets go or fires, it shows here, so you can see whether a gesture did what you meant.</p>
          ) : (
            <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto pr-1 text-sm" aria-label="Recent recipe activity" tabIndex={0}>
              {activity.recent.map((entry) => (
                <li key={entry.id}><span className="text-muted-foreground">{clock(entry.at)}</span> {recipeName(entry.recipe)} {MOMENT[entry.moment]}</li>
              ))}
            </ul>
          )}
          <MissButtons className="flex flex-wrap gap-2" />
        </div>
      </CardContent>
    </Card>
  );
}
