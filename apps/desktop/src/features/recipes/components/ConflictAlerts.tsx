import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import type { AutomationState } from "../../../shared/protocol/events";

/** One alert per pair of enabled recipes controlling the same thing, naming both. */
export function ConflictAlerts({ automation }: { automation: AutomationState }) {
  const nameOf = (id: string) => automation.recipes.find((recipe) => recipe.id === id)?.name ?? id;
  return (
    <>
      {automation.conflicts.map((conflict) => (
        <Alert key={`${conflict.first}:${conflict.second}`} variant="destructive">
          <AlertTitle>These gestures are fighting over {conflict.resource}</AlertTitle>
          <AlertDescription>
            “{nameOf(conflict.first)}” and “{nameOf(conflict.second)}” both control {conflict.resource}, so neither will
            work. Switch one of them off.
          </AlertDescription>
        </Alert>
      ))}
    </>
  );
}
