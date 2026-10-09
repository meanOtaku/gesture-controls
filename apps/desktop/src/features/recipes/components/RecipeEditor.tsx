import { PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useMemo, useState, type FormEvent } from "react";
import { NumberField } from "../../../components/app/NumberField";
import { SegmentedControl } from "../../../components/app/SegmentedControl";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Switch } from "../../../components/ui/switch";
import type { NumberSpec } from "../../../shared/forms/numberField";
import { useNumberDrafts } from "../../../shared/forms/useNumberDrafts";
import type { CalibrationLocation, ModelHold, Recipe, RecipeAction, RecipeStage } from "../../../shared/protocol/events";
import {
  ACTIONS,
  AXES,
  DEAD_ZONE_SPEC,
  DEVICE_KINDS,
  HOLDS,
  MAX_RECIPE_NAME_CHARS,
  MAX_STAGES,
  buildDevice,
  chainProblem,
  defaultNumbers,
  deviceNumbers,
  deviceSpecs,
  driveStage,
  holdsFor,
  isTrigger,
  leadingStages,
  nameProblem,
  type Axis,
  type DeviceKind,
  type HoldKind,
} from "../recipeModel";

type LeadingStage = Exclude<RecipeStage, { kind: "drive" }>;

type RecipeEditorProps = {
  recipe: Recipe;
  locations: CalibrationLocation[];
  /** Labels of the models that are loaded, offered when adding a model step. */
  modelLabels?: string[];
  /** Gesture library gestures, offered when adding a camera step. */
  cameraGestures?: { id: string; name: string }[];
  /** Resolves to an error message from the backend, or null once saved. */
  onSave: (recipe: Recipe) => Promise<string | null>;
  onCancel: () => void;
};

const NATIVE_SELECT = "recipe-select";
// Used only when a numeric field of a device is not shown; never parsed.
const UNUSED_SPEC: NumberSpec = { label: "Unused", min: 0, max: 0, step: 1, defaultValue: 0 };

/** Builds or edits one recipe: the steps that must hold, the wrist rotation that follows, and the device it turns. */
export function RecipeEditor({ recipe, locations, modelLabels = [], cameraGestures = [], onSave, onCancel }: RecipeEditorProps) {
  const uid = useId();
  const [name, setName] = useState(recipe.name);
  const [nameTouched, setNameTouched] = useState(false);
  const [steps, setSteps] = useState<LeadingStage[]>(() => leadingStages(recipe));
  const initialDrive = useMemo(() => driveStage(recipe), [recipe]);
  const [axis, setAxis] = useState<Axis>(initialDrive.axis);
  const [invert, setInvert] = useState(initialDrive.invert);
  const initialKind = recipe.device.kind as DeviceKind;
  const [kind, setKind] = useState<DeviceKind>(initialKind);
  const initialAction = recipe.action;
  const [action, setAction] = useState<RecipeAction>(initialAction);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const initialNumbers = useMemo(() => deviceNumbers(recipe.device, recipe.action), [recipe.device, recipe.action]);
  const specs = useMemo(() => {
    const device = deviceSpecs(kind, action);
    return { deadZone: DEAD_ZONE_SPEC, a: device.a, b: device.b ?? UNUSED_SPEC };
  }, [kind, action]);
  // Switching device or what it controls resets its two numbers to the defaults for that pair, because the same
  // number means something different in points, percent and pixels. The dead zone is the recipe's own.
  const numbers = kind === initialKind && action === initialAction ? initialNumbers : defaultNumbers(kind, action);
  const committed = useMemo(
    () => ({ deadZone: initialDrive.deadZoneDegrees, a: numbers.a, b: numbers.b }),
    [initialDrive.deadZoneDegrees, numbers.a, numbers.b],
  );
  const drafts = useNumberDrafts(specs, committed);

  const nameError = nameTouched ? nameProblem(name) : null;
  const trigger = isTrigger(action);
  const problem = chainProblem(steps, locations, trigger);
  const nameId = `${uid}-name`;
  const axisLabelId = `${uid}-axis`;
  const kindId = `${uid}-device`;

  const locationOptions = locations.map((location) => ({ value: location.id, label: location.name }));
  const firstUnusedHold = (): HoldKind => holdsFor(trigger).find((hold) => !steps.some((s) => s.kind === "hold" && s.hold === hold.value))?.value ?? "pinch";

  const setStep = (index: number, next: LeadingStage) => setSteps((current) => current.map((s, i) => (i === index ? next : s)));
  const removeStep = (index: number) => setSteps((current) => current.filter((_, i) => i !== index));

  const field = (key: "deadZone" | "a" | "b") => (
    <NumberField
      id={`${uid}-${key}`}
      spec={specs[key]}
      state={drafts.fields[key]}
      showEdited={false}
      onChange={(text) => drafts.setText(key, text)}
      onBlur={() => drafts.touch(key)}
      onResetToDefault={() => drafts.resetToDefault(key)}
    />
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setNameTouched(true);
    if (nameProblem(name) !== null) {
      document.getElementById(nameId)?.focus();
      return;
    }
    if (problem !== null) return;
    // A trigger has no wrist rotation or device, so there is nothing numeric to check.
    const result = trigger ? null : drafts.submit();
    if (result && result.values === null) {
      document.getElementById(`${uid}-${result.firstInvalid}`)?.focus();
      return;
    }
    const { deadZone, a, b } = result?.values ?? { deadZone: DEAD_ZONE_SPEC.defaultValue, ...defaultNumbers("rotationKnob") };
    setSaving(true);
    setServerError(null);
    const error = await onSave({
      ...recipe,
      name: name.trim(),
      stages: trigger ? steps : [...steps, { kind: "drive", axis, deadZoneDegrees: deadZone, invert }],
      action,
      device: trigger ? buildDevice("rotationKnob", defaultNumbers("rotationKnob")) : buildDevice(kind, { a, b }, action),
    });
    setSaving(false);
    if (error !== null) setServerError(error);
  };

  const showSecond = deviceSpecs(kind, action).b !== null;

  return (
    <form noValidate aria-label={recipe.id === "" ? "New recipe" : `Edit ${recipe.name}`} className="recipe-editor" onSubmit={submit}>
      <div className="field" data-invalid={nameError !== null || undefined}>
        <div className="field-head">
          <Label htmlFor={nameId} required>Name</Label>
        </div>
        <Input
          id={nameId}
          value={name}
          maxLength={MAX_RECIPE_NAME_CHARS + 10}
          placeholder="e.g. Pinch to change volume"
          aria-invalid={nameError !== null}
          aria-describedby={`${nameId}-message`}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setNameTouched(true)}
        />
        <p id={`${nameId}-message`} className={nameError ? "field-error" : "field-hint"}>
          {nameError ?? "Shown on the Control center and in conflict messages."}
        </p>
      </div>

      <fieldset className="recipe-steps">
        <legend>{trigger ? "Fire when all of these hold" : "When all of these hold"}</legend>
        <ol aria-label="Steps">
          {steps.map((step, index) => {
            const label = `Step ${index + 1}`;
            return (
              <li key={index} className="recipe-step">
                <select
                  className={NATIVE_SELECT}
                  aria-label={`${label} type`}
                  value={step.kind}
                  onChange={(event) =>
                    setStep(
                      index,
                      event.target.value === "headAt"
                        ? { kind: "headAt", location: locationOptions[0]?.value ?? "" }
                        : event.target.value === "model"
                          ? { kind: "model", label: modelLabels[0] ?? "", hold: "held" }
                          : event.target.value === "camera"
                            ? { kind: "camera", gesture: cameraGestures[0]?.id ?? "", hold: "held" }
                            : { kind: "hold", hold: firstUnusedHold() },
                    )
                  }
                >
                  <option value="headAt">Look at</option>
                  <option value="hold">Gesture</option>
                  <option value="model">Model label</option>
                  <option value="camera">Camera gesture</option>
                </select>
                {step.kind === "headAt" ? (
                  <select
                    className={NATIVE_SELECT}
                    aria-label={`${label} location`}
                    value={step.location}
                    onChange={(event) => setStep(index, { kind: "headAt", location: event.target.value })}
                  >
                    {!locationOptions.some((option) => option.value === step.location) && (
                      <option value={step.location}>(removed location)</option>
                    )}
                    {locationOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                ) : step.kind === "camera" ? (
                  <>
                    <select
                      className={NATIVE_SELECT}
                      aria-label={`${label} camera gesture`}
                      value={step.gesture}
                      onChange={(event) => setStep(index, { ...step, gesture: event.target.value })}
                    >
                      {!cameraGestures.some((gesture) => gesture.id === step.gesture) && <option value={step.gesture}>{step.gesture === "" ? "Choose a gesture…" : "(removed gesture)"}</option>}
                      {cameraGestures.map((gesture) => <option key={gesture.id} value={gesture.id}>{gesture.name}</option>)}
                    </select>
                    <select
                      className={NATIVE_SELECT}
                      aria-label={`${label} camera timing`}
                      value={step.hold}
                      onChange={(event) => setStep(index, { ...step, hold: event.target.value as ModelHold })}
                    >
                      <option value="held">While seen</option>
                      {(trigger || step.hold === "oneShot") && <option value="oneShot">Once, when seen</option>}
                    </select>
                  </>
                ) : step.kind === "model" ? (
                  <>
                    <input
                      className={NATIVE_SELECT}
                      aria-label={`${label} model label`}
                      list={`${uid}-labels`}
                      value={step.label}
                      placeholder="label, e.g. snap_fingers"
                      spellCheck={false}
                      onChange={(event) => setStep(index, { ...step, label: event.target.value.trim().toLowerCase() })}
                    />
                    <select
                      className={NATIVE_SELECT}
                      aria-label={`${label} model timing`}
                      value={step.hold}
                      onChange={(event) => setStep(index, { ...step, hold: event.target.value as ModelHold })}
                    >
                      <option value="held">While detected</option>
                      {(trigger || step.hold === "oneShot") && <option value="oneShot">Once, when detected</option>}
                    </select>
                  </>
                ) : (
                  <select
                    className={NATIVE_SELECT}
                    aria-label={`${label} gesture`}
                    value={step.hold}
                    onChange={(event) => setStep(index, { kind: "hold", hold: event.target.value as HoldKind })}
                  >
                    {HOLDS.filter((hold) => holdsFor(trigger).includes(hold) || hold.value === step.hold).map((hold) => (
                      <option key={hold.value} value={hold.value}>{hold.label}</option>
                    ))}
                  </select>
                )}
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${label.toLowerCase()}`} onClick={() => removeStep(index)}>
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ol>
        {steps.length === 0 && !trigger && <p className="field-hint">No steps: the wrist rotation below starts the moment the watch has an orientation. Add a step to gate it.</p>}
        <div className="recipe-step-add">
          <Button
            type="button"
            variant="outline"
            disabled={steps.length + (trigger ? 0 : 1) >= MAX_STAGES || locationOptions.length === 0}
            onClick={() => setSteps((current) => [...current, { kind: "headAt", location: locationOptions[0].value }])}
          >
            <PlusIcon aria-hidden="true" /> Look at a location
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={steps.length + (trigger ? 0 : 1) >= MAX_STAGES}
            onClick={() => setSteps((current) => [...current, { kind: "hold", hold: firstUnusedHold() }])}
          >
            <PlusIcon aria-hidden="true" /> Add a gesture
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={steps.length + (trigger ? 0 : 1) >= MAX_STAGES}
            onClick={() => setSteps((current) => [...current, { kind: "model", label: modelLabels[0] ?? "", hold: "held" }])}
          >
            <PlusIcon aria-hidden="true" /> Add a model label
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={steps.length + (trigger ? 0 : 1) >= MAX_STAGES || cameraGestures.length === 0}
            title={cameraGestures.length === 0 ? "Make a gesture in the Gesture library first" : undefined}
            onClick={() => setSteps((current) => [...current, { kind: "camera", gesture: cameraGestures[0].id, hold: "held" }])}
          >
            <PlusIcon aria-hidden="true" /> Add a camera gesture
          </Button>
          <datalist id={`${uid}-labels`}>
            {modelLabels.map((label) => <option key={label} value={label} />)}
          </datalist>
        </div>
        {steps.some((step) => step.kind === "hold" && step.hold.startsWith("swipe")) && (
          <p className="field-hint">Swipes are read from the watch's acceleration and orientation. Left and right run along your forearm, so set which side the watch's crown is on under Settings → Watch orientation; up and down follow gravity.</p>
        )}
        {steps.some((step) => step.kind === "hold" && step.hold.startsWith("pitch")) && (
          <p className="field-hint">A pitch is one quick nod of the hand at the wrist, up or down, like a stop sign or a wave. It is not the slow tilt that turns a dial. Which way is up depends on Settings → Watch orientation.</p>
        )}
        {steps.some((step) => step.kind === "hold" && step.hold.startsWith("roll")) && (
          <p className="field-hint">A roll is one quick twist of the wrist about your forearm, like turning a key. It is not the slow roll that turns a dial: that is the wrist rotation step of a volume, brightness or scroll recipe.</p>
        )}
        {steps.some((step) => step.kind === "hold" && (step.hold === "tap" || step.hold === "doubleTap")) && (
          <p className="field-hint">A tap is a knock of a finger on the watch, felt as one sharp jolt while your arm is still. A single tap fires about 0.4 seconds after the knock, once it is clear no second one is coming. Tune it in Settings.</p>
        )}
        {steps.some((step) => step.kind === "hold" && step.hold === "shake") && (
          <p className="field-hint">A shake needs the watch's acceleration sensor switched on. It counts as happening for about half a second after it is recognised.</p>
        )}
        {steps.some((step) => step.kind === "model") && (
          <p className="field-hint">
            A model label is detected by a model you trained and activated.
            {modelLabels.length === 0 ? " None is loaded yet, so a recipe using one will not run until you load one." : ` Loaded now: ${modelLabels.join(", ")}.`}{" "}
            “While detected” works like a pinch and can keep a dial turning; “Once, when detected” is a moment, like a shake, and only starts a button action. Detections only act when the model runtime is in Live mode.
          </p>
        )}
        {steps.some((step) => step.kind === "camera") && (
          <p className="field-hint">
            A camera gesture is one from your Gesture library, seen through this computer's camera. It only works while this app is open with its camera on (turn it on in the Gesture library or Recorder), and it stops the moment the camera or the app stops reporting. It acts about as soon as its “hold before it counts” time passes.
            “While seen” works like a pinch and can keep a dial turning; “Once, when seen” only starts a button action.
          </p>
        )}
        {problem && <p className="field-error" role="alert">{problem}</p>}
      </fieldset>

      <fieldset className="recipe-steps">
        <legend>To control</legend>
        <div className="field">
        <div className="field-head"><Label htmlFor={`${uid}-action`}>Controls</Label></div>
        <select
          id={`${uid}-action`}
          className={NATIVE_SELECT}
          value={action}
          onChange={(event) => setAction(event.target.value as RecipeAction)}
        >
          {ACTIONS.map((candidate) => (
            <option key={candidate.value} value={candidate.value}>{candidate.label}</option>
          ))}
        </select>
        <p className="field-hint">{ACTIONS.find((candidate) => candidate.value === action)?.summary}</p>
        </div>
      </fieldset>

      {!trigger && (
        <>
      <fieldset className="recipe-steps">
        <legend>Then turn your wrist</legend>
        <div className="field">
          <div className="field-head"><span id={axisLabelId} className="field-label">Axis</span></div>
          <SegmentedControl
            labelledBy={axisLabelId}
            value={axis}
            onValueChange={setAxis}
            options={AXES.map((a) => ({ value: a.value, label: a.label }))}
          />
          <p className="field-hint">Roll turns the forearm like a screwdriver; pitch tilts the hand up and down; yaw swings it left and right.</p>
        </div>
        <div className="recipe-row">
          {field("deadZone")}
          <label className="recipe-switch">
            <Switch checked={invert} onCheckedChange={setInvert} />
            <span>Reverse direction</span>
          </label>
        </div>
      </fieldset>

      <fieldset className="recipe-steps">
        <legend>Which moves this virtual device</legend>
        <div className="field">
          <div className="field-head"><Label htmlFor={kindId}>Device</Label></div>
          <select
            id={kindId}
            className={NATIVE_SELECT}
            value={kind}
            onChange={(event) => {
              const next = event.target.value as DeviceKind;
              setKind(next);
            }}
          >
            {DEVICE_KINDS.map((device) => (
              <option key={device.kind} value={device.kind}>{device.label}</option>
            ))}
          </select>
          <p className="field-hint">{DEVICE_KINDS.find((device) => device.kind === kind)?.summary}</p>
        </div>
        <div className="recipe-row">
          {field("a")}
          {showSecond && field("b")}
        </div>
      </fieldset>

        </>
      )}

      {serverError && <p className="field-error" role="alert">{serverError}</p>}
      <div className="recipe-actions">
        <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save recipe"}</Button>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button>
        {recipe.id === "" && <small className="field-hint">New recipes start switched off.</small>}
      </div>
    </form>
  );
}
