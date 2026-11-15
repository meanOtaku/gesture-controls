import { SectionHeader } from "../../../components/app/SectionHeader";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { appNavigation } from "../../../shared/navigation/appNavigation";
import { useLabelModels } from "../../model-lab/hooks/useLabelModels";
import { modelName } from "../../model-lab/labelModels";
import { ReadinessLight } from "../../model-lab/components/ReadinessLight";
import { RuntimeSwitch } from "../../model-lab/components/RuntimeSwitch";

/**
 * What the trained models are doing, on the home page: Off, Monitor or Live, which models are active, and whether a
 * pinch made now would be caught. Only in the desktop app, where the models run.
 */
export function PinchControlCard() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const { models } = useLabelModels(desktopAvailable);
  if (!desktopAvailable) return null;
  const active = models.filter((model) => model.state === "active");
  return (
    <Card role="region" aria-label="Trained models">
      <CardHeader>
        <SectionHeader
          title="Trained models"
          description={active.length === 0 ? "No model is active." : `Active: ${active.map((model) => `${model.label} (${modelName(model)})`).join(", ")}.`}
          status={<Button type="button" variant="outline" onClick={() => appNavigation.open("modelLab")}>Model Lab →</Button>}
        />
      </CardHeader>
      <CardContent className="flex flex-wrap items-start gap-4">
        <div className="min-w-64 flex-1"><RuntimeSwitch variant="page" /></div>
        <ReadinessLight />
      </CardContent>
    </Card>
  );
}
