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
import { formatNumber } from "../../../shared/forms/numberField";
import { HeadRangeCalibration } from "./HeadRangeCalibration";
import { WristRangeCalibration } from "./WristRangeCalibration";
import type { CalibrationLocation, ModelHold, PointerMode, PointerSource, Recipe, RecipeAction, ScreenAnchor } from "../../../shared/protocol/events";
import {
  ACTIONS,
  AXES,
  DEAD_ZONE_SPEC,
  DEVICE_KINDS,
  HOLDS,
  POINTER_LOOKBACK_SPEC,
  POINTER_SPEED_SPEC,
  MAX_RECIPE_NAME_CHARS,
  MAX_STAGES,
  actionInfo,
  buildDevice,
  chainProblem,
  defaultNumbers,
  deviceNumbers,
  deviceSpecs,
  driveStage,
  holdsFor,
  isMomentaryStage,
  isPointer,
  isTrigger,
  pointerLabelsProblem,
  HEAD_RANGE_ACROSS_SPEC,
  HEAD_RANGE_UP_SPEC,
  POINTER_MODES,
  POINTER_SOURCES,
  pointerStage,
  shortcutProblem,
  appsProblem,
  parseApps,
  leadingStages,
  nameProblem,
  SCREEN_ANCHORS,
  anchorLabel,
  lookedAtAnchor,
  showsOverlay,
  type Axis,
  type DeviceKind,
  type HoldKind,
  type LeadingStage,
} from "../recipeModel";

type RecipeEditorProps = {
  recipe: Recipe;
  locations: CalibrationLocation[];
  /** Labels of the models that are loaded, offered when adding a model step. */
  modelLabels?: string[];
  /** Gesture library gestures, offered when adding a camera step. */
  cameraGestures?: { id: string; name: string }[];
  /** Held gestures (with a start and an end phase), offered for a grab / release step: their start grabs, their end releases. */
  heldGestures?: { id: string; name: string; start: string; end: string }[];
  /** Resolves to an error message from the backend, or null once saved. */
  onSave: (recipe: Recipe) => Promise<string | null>;
  onCancel: () => void;
};

const NATIVE_SELECT = "recipe-select";
// Used only when a numeric field of a device is not shown; never parsed.
const UNUSED_SPEC: NumberSpec = { label: "Unused", min: 0, max: 0, step: 1, defaultValue: 0 };

/** Builds or edits one recipe: the steps that must hold, the wrist rotation that follows, and the device it turns. */
export function RecipeEditor({ recipe, locations, modelLabels = [], cameraGestures = [], heldGestures = [], onSave, onCancel }: RecipeEditorProps) {
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
  const [keys, setKeys] = useState(recipe.keys ?? "");
  const [keysTouched, setKeysTouched] = useState(false);
  const [appsText, setAppsText] = useState((recipe.apps ?? []).join(", "));
  // "" is where the recipe is looked at.
  const [overlayAt, setOverlayAt] = useState<ScreenAnchor | "">(recipe.overlayAt ?? "");
  const initialPointer = useMemo(() => pointerStage(recipe), [recipe]);
  const [pressLabel, setPressLabel] = useState(initialPointer.pressLabel);
  const [holdLabel, setHoldLabel] = useState(initialPointer.holdLabel);
  const [releaseLabel, setReleaseLabel] = useState(initialPointer.releaseLabel);
  // A pointer step saved before the choice existed moved the pointer like a mouse.
  const [pointerMode, setPointerMode] = useState<PointerMode>(initialPointer.mode ?? "mouse");
  const [pointerSource, setPointerSource] = useState<PointerSource>(initialPointer.source ?? "watch");
  const [reverseAcross, setReverseAcross] = useState(initialPointer.reverseAcross ?? false);
  const [reverseUp, setReverseUp] = useState(initialPointer.reverseUp ?? false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const initialNumbers = useMemo(() => deviceNumbers(recipe.device, recipe.action), [recipe.device, recipe.action]);
  const specs = useMemo(() => {
    const device = deviceSpecs(kind, action);
    return { deadZone: DEAD_ZONE_SPEC, a: device.a, b: device.b ?? UNUSED_SPEC, speed: POINTER_SPEED_SPEC, lookback: POINTER_LOOKBACK_SPEC, rangeAcross: HEAD_RANGE_ACROSS_SPEC, rangeUp: HEAD_RANGE_UP_SPEC };
  }, [kind, action]);
  // Switching device or what it controls resets its two numbers to the defaults for that pair, because the same
  // number means something different in points, percent and pixels. The dead zone is the recipe's own.
  const numbers = kind === initialKind && action === initialAction ? initialNumbers : defaultNumbers(kind, action);
  const committed = useMemo(
    () => ({
      deadZone: initialDrive.deadZoneDegrees,
      a: numbers.a,
      b: numbers.b,
      speed: initialPointer.pixelsPerDegree,
      lookback: initialPointer.lookbackMs,
      rangeAcross: initialPointer.headRange?.acrossDegrees ?? HEAD_RANGE_ACROSS_SPEC.defaultValue,
      rangeUp: initialPointer.headRange?.upDegrees ?? HEAD_RANGE_UP_SPEC.defaultValue,
    }),
    [initialDrive.deadZoneDegrees, numbers.a, numbers.b, initialPointer.pixelsPerDegree, initialPointer.lookbackMs, initialPointer.headRange],
  );
  const drafts = useNumberDrafts(specs, committed);

  const nameError = nameTouched ? nameProblem(name) : null;
  const trigger = isTrigger(action);
  const pointer = isPointer(action);
  const problem = chainProblem(steps, locations, trigger, pointer);
  const pointerError = pointer ? pointerLabelsProblem({ pressLabel, holdLabel, releaseLabel }) : null;
  const keysError = action === "shortcut" ? shortcutProblem(keys) : null;
  const apps = parseApps(appsText);
  const appsError = appsProblem(apps);
  const nameId = `${uid}-name`;
  const axisLabelId = `${uid}-axis`;
  const kindId = `${uid}-device`;

  const locationOptions = locations.map((location) => ({ value: location.id, label: location.name }));
  const firstUnusedHold = (): HoldKind => holdsFor(trigger).find((hold) => !steps.some((s) => s.kind === "hold" && s.hold === hold.value))?.value ?? "stemButton";

  const setStep = (index: number, next: LeadingStage) => setSteps((current) => current.map((s, i) => (i === index ? next : s)));
  const removeStep = (index: number) => setSteps((current) => current.filter((_, i) => i !== index));

  const field = (key: "deadZone" | "a" | "b" | "speed" | "lookback" | "rangeAcross" | "rangeUp") => (
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
    if (problem !== null || pointerError !== null) return;
    if (appsError !== null) {
      document.getElementById(`${uid}-apps`)?.focus();
      return;
    }
    if (keysError !== null) {
      setKeysTouched(true);
      document.getElementById(`${uid}-keys`)?.focus();
      return;
    }
    // A trigger has no wrist rotation or device, so there is nothing numeric to check.
    const result = trigger ? null : drafts.submit();
    if (result && result.values === null) {
      document.getElementById(`${uid}-${result.firstInvalid}`)?.focus();
      return;
    }
    const { deadZone, a, b, speed, lookback, rangeAcross, rangeUp } = result?.values ?? {
      deadZone: DEAD_ZONE_SPEC.defaultValue,
      ...defaultNumbers("rotationKnob"),
      speed: POINTER_SPEED_SPEC.defaultValue,
      lookback: POINTER_LOOKBACK_SPEC.defaultValue,
      rangeAcross: HEAD_RANGE_ACROSS_SPEC.defaultValue,
      rangeUp: HEAD_RANGE_UP_SPEC.defaultValue,
    };
    // The head always goes by its range; the hand has none.
    const headRange = pointerSource === "head" ? { headRange: { acrossDegrees: rangeAcross, upDegrees: rangeUp } } : {};
    const last = pointer
      ? [{ kind: "pointer" as const, pixelsPerDegree: speed, pressLabel, holdLabel, releaseLabel, lookbackMs: Math.round(lookback), mode: pointerMode, source: pointerSource, reverseAcross, reverseUp, ...headRange }]
      : trigger
        ? []
        : [{ kind: "drive" as const, axis, deadZoneDegrees: deadZone, invert }];
    setSaving(true);
    setServerError(null);
    const error = await onSave({
      ...recipe,
      name: name.trim(),
      stages: [...steps, ...last],
      action,
      keys: action === "shortcut" ? keys.trim() : undefined,
      apps: apps.length > 0 ? apps : undefined,
      overlayAt: showsOverlay(action) && overlayAt !== "" ? overlayAt : undefined,
      device: trigger || pointer ? buildDevice("rotationKnob", defaultNumbers("rotationKnob")) : buildDevice(kind, { a, b }, action),
    });
    setSaving(false);
    if (error !== null) setServerError(error);
  };

  const showSecond = deviceSpecs(kind, action).b !== null;
  // The device's numbers as typed, for showing and calibrating the wrist range; null while one is not a number.
  const draftA = Number(drafts.fields.a.text);
  const draftB = showSecond ? Number(drafts.fields.b.text) : 0;
  const draftNumbers = drafts.fields.a.text.trim() !== "" && Number.isFinite(draftA) && Number.isFinite(draftB) ? { a: draftA, b: draftB } : null;

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
                        : event.target.value === "modelPair"
                          ? { kind: "modelPair", startLabel: (heldGestures.find((g) => g.id === "pinch") ?? heldGestures[0])?.start ?? "pinch_in", endLabel: (heldGestures.find((g) => g.id === "pinch") ?? heldGestures[0])?.end ?? "pinch_out" }
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
                  {!trigger && !pointer && <option value="modelPair">Grab / release</option>}
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
                ) : step.kind === "modelPair" ? (
                  <>
                    {heldGestures.length > 0 && (
                      <select
                        className={NATIVE_SELECT}
                        aria-label={`${label} held gesture`}
                        value={heldGestures.find((g) => g.start === step.startLabel && g.end === step.endLabel)?.id ?? ""}
                        onChange={(event) => {
                          const gesture = heldGestures.find((g) => g.id === event.target.value);
                          if (gesture) setStep(index, { ...step, startLabel: gesture.start, endLabel: gesture.end });
                        }}
                      >
                        {!heldGestures.some((g) => g.start === step.startLabel && g.end === step.endLabel) && <option value="">Other labels (below)</option>}
                        {heldGestures.map((gesture) => <option key={gesture.id} value={gesture.id}>{gesture.name}</option>)}
                      </select>
                    )}
                    <label>Grab label<input className={NATIVE_SELECT} aria-label={`${label} grab label`} list={`${uid}-labels`} value={step.startLabel} onChange={(e) => setStep(index, { ...step, startLabel: e.target.value.trim().toLowerCase() })} /></label>
                    <label>Release label<input className={NATIVE_SELECT} aria-label={`${label} release label`} list={`${uid}-labels`} value={step.endLabel} onChange={(e) => setStep(index, { ...step, endLabel: e.target.value.trim().toLowerCase() })} /></label>
                    <p className="field-hint">The gesture's start grabs (pinch in, for pinch); turn left to decrease, right to increase; its end releases. Choose any held gesture (one with start and end phases, made on the Labels page), or type the two labels. Use Reverse direction if your watch orientation reverses the movement.</p>
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
                      {(trigger || pointer || step.hold === "oneShot") && <option value="oneShot">Once, when detected</option>}
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
        {steps.length === 0 && !trigger && !pointer && <p className="field-hint">No steps: the wrist rotation below starts the moment the watch has an orientation. Add a step to gate it.</p>}
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
        {steps.some((step) => step.kind === "hold" && step.hold.startsWith("shake")) && (
          <p className="field-hint">A shake needs the watch's acceleration sensor switched on. It counts as happening for about half a second after it is recognised. Up and down is judged against gravity, so it is the same shake however your hand is turned; side to side is level with the ground; along the forearm is in and out, like a pump. A shake between those directions only counts as “any direction”.</p>
        )}
        {steps.some((step) => step.kind === "hold" && step.hold === "wiggle") && (
          <p className="field-hint">A wiggle is a quick twist of the wrist back and forth, like rattling a door knob: four twists in about a second. One twist is a roll, not a wiggle.</p>
        )}
        {steps.some((step) => step.kind === "hold" && step.hold === "hammer") && (
          <p className="field-hint">A hammer is your fist brought down on your other palm (a clap works too): the moving arm stopping dead, then resting. It fires about a quarter of a second after the blow.</p>
        )}
        {pointer && steps.some(isMomentaryStage) && (
          <p className="field-hint">In a pointer recipe a momentary step is a switch: do it once (a snap, say) to turn pointer mode on, and again to turn it off. Pointer mode also turns itself off after 30 seconds with the pointer still, or when another step lets go, and the mouse button is never left down when it does. Pinches in the first 0.4 seconds after it comes on are ignored, because a snap can look like one.</p>
        )}
        {!trigger && !pointer && steps.some(isMomentaryStage) && (
          <p className="field-hint">In a dial recipe a momentary step is a switch: do it once to turn the dial on, turn your wrist, then do it again to turn the dial off. The dial also turns itself off after six seconds without moving, or when another step lets go. A tap or double tap disturbs the wrist least.</p>
        )}
        {steps.some((step) => step.kind === "model" || step.kind === "modelPair") && (
          <p className="field-hint">
            A model label is detected by a model you trained and activated.
            {modelLabels.length === 0 ? " None is loaded yet, so a recipe using one will not run until you load one." : ` Loaded now: ${modelLabels.join(", ")}.`}{" "}
            “While detected” works like a pinch and can keep a dial turning; “Once, when detected” is a moment, like a shake: it presses a button, or switches a dial on and off. Detections only act when the model runtime is in Live mode.
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
        <div className="field">
          <div className="field-head"><Label htmlFor={`${uid}-apps`}>Only in these apps</Label></div>
          <Input
            id={`${uid}-apps`}
            value={appsText}
            placeholder="Everywhere"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={appsError !== null}
            aria-describedby={`${uid}-apps-hint`}
            onChange={(event) => setAppsText(event.target.value)}
          />
          {appsError !== null
            ? <p className="field-error" role="alert" id={`${uid}-apps-hint`}>{appsError}</p>
            : <p className="field-hint" id={`${uid}-apps-hint`}>Leave empty to work everywhere. Or name apps as the system shows them, separated by commas (Safari, Spotify): the recipe then only works while one of them is in front, so the same gesture can do something else in another app. Recipes for different apps do not conflict. Works on a Mac, and on Linux with xdotool; not on Windows yet.</p>}
        </div>
        {action === "shortcut" && (
          <div className="field">
            <div className="field-head"><Label htmlFor={`${uid}-keys`}>Shortcut</Label></div>
            <Input
              id={`${uid}-keys`}
              value={keys}
              placeholder="cmd+shift+4"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={keysTouched && keysError !== null}
              aria-describedby={`${uid}-keys-hint`}
              onChange={(event) => setKeys(event.target.value)}
              onBlur={() => setKeysTouched(true)}
            />
            {keysTouched && keysError !== null
              ? <p className="field-error" role="alert" id={`${uid}-keys-hint`}>{keysError}</p>
              : <p className="field-hint" id={`${uid}-keys-hint`}>Modifiers (cmd, ctrl, alt, shift) joined with + and then one key: a letter, a digit, f1 to f12, or space, enter, tab, escape, backspace, delete, an arrow (left, right, up, down), home, end, pageup or pagedown. On Windows and Linux, cmd is the Windows or Super key.</p>}
          </div>
        )}
      </fieldset>

      {pointer && (
        <fieldset className="recipe-steps">
          <legend>Then point</legend>
          <div className="field">
            <div className="field-head"><span id={`${uid}-pointer-source`} className="field-label">Moved by</span></div>
            <SegmentedControl
              labelledBy={`${uid}-pointer-source`}
              value={pointerSource}
              onValueChange={setPointerSource}
              options={POINTER_SOURCES.map((source) => ({ value: source.value, label: source.label }))}
            />
            <p className="field-hint">{POINTER_SOURCES.find((source) => source.value === pointerSource)?.detail}</p>
          </div>
          {pointerSource === "watch" && (
            <div className="field">
              <div className="field-head"><span id={`${uid}-pointer-mode`} className="field-label">Moves like</span></div>
              <SegmentedControl
                labelledBy={`${uid}-pointer-mode`}
                value={pointerMode}
                onValueChange={setPointerMode}
                options={POINTER_MODES.map((mode) => ({ value: mode.value, label: mode.label }))}
              />
              <p className="field-hint">{POINTER_MODES.find((mode) => mode.value === pointerMode)?.detail}</p>
            </div>
          )}
          <div className="recipe-row">
            <label className="recipe-switch">
              <Switch checked={reverseAcross} onCheckedChange={setReverseAcross} />
              <span>Reverse left and right</span>
            </label>
            <label className="recipe-switch">
              <Switch checked={reverseUp} onCheckedChange={setReverseUp} />
              <span>Reverse up and down</span>
            </label>
          </div>
          {pointerSource === "head" && (
            <>
              <div className="recipe-row">
                {field("rangeAcross")}
                {field("rangeUp")}
              </div>
              <HeadRangeCalibration
                onCalibrated={({ across, up }) => {
                  drafts.setText("rangeAcross", formatNumber(Math.round(across)));
                  drafts.setText("rangeUp", formatNumber(Math.round(up)));
                }}
              />
            </>
          )}
          <div className="recipe-row">
            {pointerSource === "watch" && field("speed")}
            {field("lookback")}
          </div>
          <div className="recipe-row">
            <label>Press label<input className={NATIVE_SELECT} aria-label="Press label" list={`${uid}-labels`} value={pressLabel} spellCheck={false} onChange={(e) => setPressLabel(e.target.value.trim().toLowerCase())} /></label>
            <label>Hold label<input className={NATIVE_SELECT} aria-label="Hold label" list={`${uid}-labels`} value={holdLabel} spellCheck={false} onChange={(e) => setHoldLabel(e.target.value.trim().toLowerCase())} /></label>
            <label>Release label<input className={NATIVE_SELECT} aria-label="Release label" list={`${uid}-labels`} value={releaseLabel} spellCheck={false} onChange={(e) => setReleaseLabel(e.target.value.trim().toLowerCase())} /></label>
          </div>
          <p className="field-hint">A press start followed soon by a release is a click. If the hold is detected first, the button goes down and the hand drags until the release; the button also comes up if the hold is gone for 1.5 seconds, in case the release is missed. A press with nothing after it for 2 seconds is forgotten.</p>
          {pointerError && <p className="field-error" role="alert">{pointerError}</p>}
        </fieldset>
      )}

      {!trigger && !pointer && (
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
        {!trigger && !pointer && (
          <WristRangeCalibration
            axis={axis}
            kind={kind}
            scale={actionInfo(action).scale}
            numbers={draftNumbers}
            onCalibrated={({ a, b }) => {
              drafts.setText("a", formatNumber(a));
              if (showSecond) drafts.setText("b", formatNumber(b));
            }}
          />
        )}
        {showsOverlay(action) && (
          <div className="field">
            <div className="field-head"><Label htmlFor={`${uid}-overlay-at`}>Show it on screen at</Label></div>
            <select
              id={`${uid}-overlay-at`}
              className={NATIVE_SELECT}
              value={overlayAt}
              onChange={(event) => setOverlayAt(event.target.value as ScreenAnchor | "")}
            >
              <option value="">Where you look ({anchorLabel(lookedAtAnchor(steps))})</option>
              {SCREEN_ANCHORS.map((anchor) => (
                <option key={anchor.value} value={anchor.value}>{anchor.label}</option>
              ))}
            </select>
            <p className="field-hint">
              Where the knob or slider appears while this recipe runs. "Where you look" follows the location in its first step,
              read from its name (top left, bottom edge, center…), and is the top right when it names no place.
            </p>
          </div>
        )}
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
