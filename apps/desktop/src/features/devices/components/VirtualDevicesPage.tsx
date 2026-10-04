import { useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { AutomationState } from "../../../shared/protocol/events";
import { DEVICE_KINDS, buildDevice, defaultNumbers, deviceSpecs, type DeviceKind } from "../../recipes/recipeModel";
import { devicePosition } from "../deviceMath";
import { DevicePreview } from "./DevicePreview";

type VirtualDevicesPageProps = {
  automation: AutomationState | null;
  /** Opens the recipe editor with this device already chosen. */
  onMakeRecipe: (kind: DeviceKind) => void;
};

const signed = (points: number) => `${points > 0 ? "+" : ""}${Number(points.toFixed(1))} pts`;

/** The virtual devices a recipe can turn the wrist into, each with a live preview you can try with a slider. */
export function VirtualDevicesPage({ automation, onMakeRecipe }: VirtualDevicesPageProps) {
  const [degrees, setDegrees] = useState(0);
  const sliderId = "virtual-devices-rotation";

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Virtual devices</h1>
          <p className="subtitle">The knobs and faders your wrist movements turn, and what they control.</p>
        </div>
      </header>

      <Card role="region" aria-label="Try the devices">
        <CardHeader>
          <SectionHeader
            title="Try them"
            description="Rotation from where the hold began"
            help={{
              label: "About the preview",
              content: "Drag the slider as if you were turning your wrist after starting a recipe. Each device shows where it would be and how many volume points it would change, using its default settings. Each recipe keeps its own settings, which you set in the recipe.",
            }}
          />
        </CardHeader>
        <CardContent className="field">
          <div className="field-head">
            <label htmlFor={sliderId}>Wrist rotation</label>
            <span className="field-unit-inline">{degrees > 0 ? "+" : ""}{degrees}°</span>
          </div>
          <input
            id={sliderId}
            className="device-slider"
            type="range"
            min={-180}
            max={180}
            step={1}
            value={degrees}
            aria-valuetext={`${degrees} degrees`}
            onChange={(event) => setDegrees(Number(event.target.value))}
          />
          <p className="field-hint">Negative turns the other way. Zero is where you were when the hold began.</p>
        </CardContent>
      </Card>

      <div className="device-grid">
        {DEVICE_KINDS.map(({ kind, label, summary }) => {
          const device = buildDevice(kind, defaultNumbers(kind));
          const points = devicePosition(device, degrees) * 100;
          const specs = deviceSpecs(kind);
          const usedBy = automation?.recipes.filter((recipe) => recipe.device.kind === kind) ?? [];
          return (
            <Card key={kind} role="region" aria-label={label}>
              <CardHeader>
                <SectionHeader title={label} description="Virtual device" />
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <DevicePreview device={device} degrees={degrees} />
                <p className="device-readout" aria-live="polite">
                  Volume change <strong>{signed(points)}</strong>
                </p>
                <p className="field-hint">{summary}</p>
                <p className="field-hint">
                  Settings: {specs.a.label.toLowerCase()} {specs.a.defaultValue.toFixed(specs.a.step < 1 ? 2 : 0)} {specs.a.unit}
                  {specs.b && `, ${specs.b.label.toLowerCase()} ${specs.b.defaultValue} ${specs.b.unit}`}
                </p>
                <p className="field-hint">
                  {usedBy.length === 0 ? "No recipe uses it yet." : `Used by ${usedBy.map((recipe) => recipe.name).join(", ")}.`}
                </p>
                <div>
                  <Button type="button" variant="outline" onClick={() => onMakeRecipe(kind)}>
                    Make a recipe with this
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </main>
  );
}
