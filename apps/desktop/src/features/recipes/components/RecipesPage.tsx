import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { AdvancedSection } from "../../../components/app/AdvancedSection";
import { VirtualDevices } from "../../devices/components/VirtualDevices";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";
import type { AutomationState, CalibrationState, HeuristicGestures, Recipe } from "../../../shared/protocol/events";
import { CameraArmSwitch } from "../../gestureLibrary/CameraArmSwitch";
import { listGestureDefinitions } from "../../gestureLibrary/gestureLibraryApi";
import { pinchVolumeRecipe, blankRecipe, describeRecipe, offGesturesUsed, type DeviceKind } from "../recipeModel";
import { ConflictAlerts } from "./ConflictAlerts";
import { RecipeEditor } from "./RecipeEditor";
import { invoke } from "@tauri-apps/api/core";
import { gestureGroups, isHeld } from "../../labels/gestures";
import type { DatasetLabel } from "../../model-lab/types";

type RecipesPageProps = {
  automation: AutomationState | null;
  calibration: CalibrationState | null;
  /** Ids of recipes with a change in flight. */
  pendingRecipeIds: readonly string[];
  error?: string | null;
  onSetEnabled: (id: string, enabled: boolean) => void;
  /** Resolves to an error message, or null once saved. */
  onSave: (recipe: Recipe) => Promise<string | null>;
  onDelete: (id: string) => void;
  /** Which built-in gestures are switched on in Settings; a recipe using an off one never fires. */
  builtInGestures?: HeuristicGestures;
};

/** Where recipes are made: each one chains head, pinch/button and wrist steps into a virtual device that controls something. */
export function RecipesPage({ automation, calibration, pendingRecipeIds, error, onSetEnabled, onSave, onDelete, builtInGestures }: RecipesPageProps) {
  const [editing, setEditing] = useState<Recipe | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const locations = calibration?.targets ?? [];
  // The Gesture library's gestures, which a recipe step can use. Read once when the page opens.
  const [gestures, setGestures] = useState<{ id: string; name: string }[]>([]);
  const [held, setHeld] = useState<{ id: string; name: string; start: string; end: string }[]>([]);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    void listGestureDefinitions().then((all) => setGestures(all.map(({ id, name }) => ({ id, name })))).catch(() => setGestures([]));
    // Held gestures, for a grab / release step: their start grabs, their end releases.
    void invoke<DatasetLabel[]>("list_model_labels")
      .then((labels) => setHeld(gestureGroups(Array.isArray(labels) ? labels : []).filter(isHeld)
        .map((group) => ({ id: group.gesture.id, name: group.gesture.displayName, start: group.phases.start!.id, end: group.phases.end!.id }))))
      .catch(() => setHeld([]));
  }, []);
  const gestureName = (id: string) => gestures.find((gesture) => gesture.id === id)?.name ?? "a removed gesture";
  const locationName = (id: string) => locations.find((location) => location.id === id)?.name ?? "a removed location";

  /** Opens the editor on a new recipe using this device, from the Virtual devices section. */
  const startWithDevice = (kind: DeviceKind) => {
    setEditing(blankRecipe(locations, kind));
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  };

  const save = async (recipe: Recipe) => {
    const failure = await onSave(recipe);
    if (failure === null) setEditing(null);
    return failure;
  };

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <h1>Recipes</h1>
          <p className="subtitle">Chain gestures together to control your computer.</p>
        </div>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {editing && (
        <Card role="region" aria-label="Recipe editor">
          <CardHeader>
            <SectionHeader
              title={editing.id === "" ? "New recipe" : "Edit recipe"}
              description="Steps, wrist rotation and device"
              help={{
                label: "About recipes",
                content: "Every step must hold at the same moment. Looking at a location shows the knob; the hold steps then grab it, and turning your wrist moves the virtual device, which changes the volume. A grab/release pair holds between its two events; looking away or pressing Escape ends it too.",
              }}
            />
          </CardHeader>
          <CardContent>
            <RecipeEditor recipe={editing} locations={locations} modelLabels={automation?.loadedLabels ?? []} cameraGestures={gestures} heldGestures={held} onSave={save} onCancel={() => setEditing(null)} />
          </CardContent>
        </Card>
      )}

      <Card role="region" aria-label="Your recipes">
        <CardHeader>
          <SectionHeader
            title="Your recipes"
            description="Switch on the ones you want"
            status={
              <Button type="button" variant="outline" disabled={editing !== null || calibration === null} onClick={() => setEditing(blankRecipe(locations))}>
                <PlusIcon aria-hidden="true" /> New recipe
              </Button>
            }
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {automation && <ConflictAlerts automation={automation} />}
          <Button type="button" variant="outline" disabled={editing !== null || calibration === null} onClick={() => setEditing(pinchVolumeRecipe(locations))}>Set up pinch volume knob</Button>
          <p className="field-hint">Look at the right corner, pinch to grab, turn your wrist, then release. Choose your Pinch In and Pinch Out labels in the setup; enable only one volume recipe.</p>
          {automation?.recipes.some((recipe) => recipe.stages.some((stage) => stage.kind === "camera")) && <CameraArmSwitch armed={automation.cameraArmed === true} />}
          {automation && automation.recipes.length === 0 && (
            <p className="field-hint">No recipes yet. Create one to start controlling the volume with gestures.</p>
          )}
          <ul className="flex flex-col gap-4" aria-label="Recipes">
            {automation?.recipes.map((recipe) => {
              const blocked = automation.blocked.includes(recipe.id);
              return (
                <li key={recipe.id} className="recipe-item">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm">
                      {recipe.name}{" "}
                      {blocked && <Badge variant="destructive">Paused: conflict</Badge>}
                      {automation.unavailable.some((entry) => entry.recipe === recipe.id) && (
                        <Badge variant="secondary">
                          Waiting for model: {[...new Set(automation.unavailable.filter((entry) => entry.recipe === recipe.id).map((entry) => entry.label))].join(", ")}
                        </Badge>
                      )}
                      {(automation.unavailableCameras ?? []).some((entry) => entry.recipe === recipe.id) && (
                        <Badge variant="secondary">
                          Waiting for camera: {[...new Set((automation.unavailableCameras ?? []).filter((entry) => entry.recipe === recipe.id).map((entry) => gestureName(entry.gesture)))].join(", ")}
                        </Badge>
                      )}
                      {builtInGestures && offGesturesUsed(recipe, builtInGestures).length > 0 && (
                        <Badge variant="secondary">
                          Never fires: {offGesturesUsed(recipe, builtInGestures).join(", ")} gesture off in Settings
                        </Badge>
                      )}
                    </span>
                    <small className="text-xs text-muted-foreground">{describeRecipe(recipe, locationName, gestureName)}</small>
                  </div>
                  <div className="recipe-item-actions">
                    <Switch
                      aria-label={`${recipe.name} ${recipe.enabled ? "on" : "off"}`}
                      checked={recipe.enabled}
                      disabled={pendingRecipeIds.includes(recipe.id)}
                      onCheckedChange={(checked) => onSetEnabled(recipe.id, checked)}
                    />
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Edit ${recipe.name}`} disabled={editing !== null} onClick={() => setEditing(recipe)}>
                      <PencilIcon aria-hidden="true" />
                    </Button>
                    {confirmingDelete === recipe.id ? (
                      <>
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => {
                            setConfirmingDelete(null);
                            onDelete(recipe.id);
                          }}
                        >
                          Delete {recipe.name}
                        </Button>
                        <Button type="button" variant="outline" onClick={() => setConfirmingDelete(null)}>Keep</Button>
                      </>
                    ) : (
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${recipe.name}`} onClick={() => setConfirmingDelete(recipe.id)}>
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <AdvancedSection storageKey="recipesDevices" title="Virtual devices" summary="The knobs and faders your wrist turns: try each, or start a recipe with one">
        <VirtualDevices automation={automation} onMakeRecipe={startWithDevice} />
      </AdvancedSection>
    </main>
  );
}
