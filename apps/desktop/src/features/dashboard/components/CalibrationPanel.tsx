import { useState, type FormEvent } from "react";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { NumberField } from "../../../components/app/NumberField";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { NumberSpec } from "../../../shared/forms/numberField";
import { useNumberDrafts } from "../../../shared/forms/useNumberDrafts";
import { Input } from "../../../components/ui/input";
import { MAX_LOCATIONS, MAX_LOCATION_NAME_CHARS, type CalibrationState, type CalibrationTarget } from "../../../shared/protocol/events";

/** The ranges `update_calibration_config` accepts; the defaults are `CalibrationConfig::default()` in the interaction engine. */
const CALIBRATION_FIELDS: Record<"threshold" | "dwell", NumberSpec> = {
  threshold: { label: "Activation threshold", unit: "°", min: 1, max: 180, step: 1, defaultValue: 12 },
  dwell: { label: "Activation dwell", unit: "ms", min: 50, max: 5000, step: 50, integer: true, defaultValue: 400 },
};

type CalibrationPanelProps = {
  connected: boolean;
  calibration: CalibrationState;
  isPending: (key: string) => boolean;
  onCaptureTarget: (target: CalibrationTarget) => void;
  onUpdateCalibration: (activationThresholdDegrees: number, dwellMs: number) => void;
  onAddLocation: (name: string) => void;
  onRemoveLocation: (target: CalibrationTarget) => void;
};

/** Why a new location's name cannot be used, or null. */
function locationNameProblem(name: string, calibration: CalibrationState): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Give the location a name.";
  if (trimmed.length > MAX_LOCATION_NAME_CHARS) return `Too long: the maximum is ${MAX_LOCATION_NAME_CHARS} characters.`;
  if (calibration.targets.some((location) => location.name.toLowerCase() === trimmed.toLowerCase())) {
    return "A location with that name already exists.";
  }
  if (calibration.targets.length >= MAX_LOCATIONS) return `The most locations allowed (${MAX_LOCATIONS}) has been reached.`;
  return null;
}

/** Sony head-tracker calibration: capture any number of named locations plus activation threshold/dwell tuning for the volume gesture. */
export function CalibrationPanel({
  connected,
  calibration,
  isPending,
  onCaptureTarget,
  onUpdateCalibration,
  onAddLocation,
  onRemoveLocation,
}: CalibrationPanelProps) {
  const [newName, setNewName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const nameProblem = locationNameProblem(newName, calibration);
  const showNameProblem = nameTouched && nameProblem !== null;
  const addLocation = (event: FormEvent) => {
    event.preventDefault();
    setNameTouched(true);
    if (nameProblem !== null) return;
    onAddLocation(newName.trim());
    setNewName("");
    setNameTouched(false);
  };
  const activeName = calibration.targets.find((location) => location.id === calibration.activeTarget)?.name;
  const updatePending = isPending("calibration:update");
  const drafts = useNumberDrafts(CALIBRATION_FIELDS, {
    threshold: calibration.activationThresholdDegrees,
    dwell: calibration.dwellMs,
  });

  // Applies as soon as a field is left (or Enter is pressed), but only a value that is valid: an
  // invalid one stays in the box with its error instead of looking accepted while nothing happened.
  const commit = () => {
    if (drafts.dirtyCount === 0) return;
    const result = drafts.submit();
    if (result.values === null) {
      document.getElementById(`calibration-${result.firstInvalid}`)?.focus();
      return;
    }
    onUpdateCalibration(result.values.threshold, result.values.dwell);
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    commit();
  };
  const field = (name: "threshold" | "dwell", help: string) => (
    <NumberField
      id={`calibration-${name}`}
      spec={CALIBRATION_FIELDS[name]}
      state={drafts.fields[name]}
      help={<HelpTooltip label={`About the ${CALIBRATION_FIELDS[name].label.toLowerCase()}`}>{help}</HelpTooltip>}
      onChange={(text) => drafts.setText(name, text)}
      onBlur={() => {
        drafts.touch(name);
        commit();
      }}
      onResetToDefault={() => drafts.resetToDefault(name)}
    />
  );

  return (
    <Card role="region" aria-label="Head calibration">
      <CardHeader>
        <SectionHeader
          title={calibration.requiresRecalibration ? "Calibration required" : "Calibration ready"}
          description="Head calibration"
          help={{
            label: "About head calibration",
            content: "Capture the screen center, then look at a location and capture it. Add as many locations as you like. A recipe that starts with looking at a location begins once your head crosses the threshold angle toward it and stays there for the dwell time. A tracker reset clears every capture but keeps your locations.",
          }}
          status={
            <Badge variant={activeName ? "default" : "secondary"}>
              {activeName ? `${activeName} active` : "No active target"}
            </Badge>
          }
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {calibration.requiresRecalibration && (
          <p className="calibration-warning">
            Face the screen center and capture it, then look at a location and capture that too.
            A tracker reset clears every capture.
          </p>
        )}

        <ul className="flex flex-col gap-2" aria-label="Locations">
          {calibration.targets.map((location) => {
            const capturing = isPending(`capture:${location.id}`);
            return (
              <li key={location.id} className="flex flex-wrap items-center gap-3" aria-label={location.name}>
                <div className="flex min-w-32 flex-1 flex-col">
                  <span className="text-sm">{location.name}</span>
                  <small className="text-xs text-muted-foreground">{location.calibrated ? "Saved" : "Not saved"}</small>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  aria-label={`Capture ${location.name}`}
                  disabled={!connected || capturing}
                  onClick={() => onCaptureTarget(location.id)}
                >
                  {capturing ? "Capturing…" : location.calibrated ? "Recapture" : "Capture"}
                </Button>
                {!location.builtin && (
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Remove ${location.name}`}
                    disabled={isPending(`location:remove:${location.id}`)}
                    onClick={() => onRemoveLocation(location.id)}
                  >
                    Remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>

        <form noValidate aria-label="Add location" className="field" onSubmit={addLocation}>
          <div className="flex items-start gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <Input
                id="calibration-new-location"
                aria-label="New location name"
                placeholder="New location, e.g. Left edge"
                value={newName}
                maxLength={MAX_LOCATION_NAME_CHARS + 8}
                aria-invalid={showNameProblem}
                aria-describedby="calibration-new-location-hint"
                onChange={(event) => setNewName(event.target.value)}
                onBlur={() => setNameTouched(newName !== "")}
              />
              <p id="calibration-new-location-hint" className={showNameProblem ? "field-error" : "field-hint"}>
                {showNameProblem ? nameProblem : "Add a place to look at, then capture it."}
              </p>
            </div>
            <Button type="submit" variant="outline" disabled={isPending("location:add")}>
              Add location
            </Button>
          </div>
        </form>
        <form noValidate aria-label="Activation settings" className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-busy={updatePending} onSubmit={onSubmit}>
          {field("threshold", "How far your head must turn toward a location, in degrees, before the volume gesture can activate.")}
          {field("dwell", "How long your head must hold past the threshold, in milliseconds, before the volume gesture activates.")}
          <p className="hint sm:col-span-2" role="status">
            {updatePending ? "Applying…" : "Changes apply when you leave a field or press Enter."}
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
