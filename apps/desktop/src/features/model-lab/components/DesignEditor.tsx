import { useId } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { isBuiltIn, networkSettingsOf, readsColumns, withNetwork, type DesignPreview, type NetworkDesign } from "../designs";
import { isNeural } from "../network";
import { ALL_COLUMNS, BASELINE_CHOICES, METHODS, SPIKE_METHODS, WINDOW_LENGTHS, type SpikeMethodId, type TrainMethod } from "../training";
import { ColumnsDesigner } from "./ColumnsDesigner";
import { NetworkDesigner } from "./NetworkDesigner";
import { StatisticsInputs } from "./StatisticsInputs";

const NATIVE_SELECT = "recipe-select";

/**
 * Edit one network design: what goes into the model, how the pulse sensor's spikes are pulled out, the window, and the
 * network. The numbers of inputs, layers and parameters follow as it is edited, and a reason appears when it cannot be used.
 * A built-in design is shown but cannot be changed.
 */
export function DesignEditor({
  design, onChange, preview, onSave, onCancel, saving, error,
}: {
  design: NetworkDesign;
  onChange: (next: NetworkDesign) => void;
  preview: DesignPreview | null;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const uid = useId();
  const locked = isBuiltIn(design);
  const columns = readsColumns(design);
  const settings = networkSettingsOf(design);
  const set = (patch: Partial<NetworkDesign>) => onChange({ ...design, ...patch });
  const setMethod = (method: TrainMethod) => {
    // The convolutional method always reads columns; the others keep what they had, with the network back to that method's default.
    const next: NetworkDesign = { ...design, method, network: null, readings: method === "cnn1d" ? Math.max(design.readings, 8) : Math.min(design.readings, 64) };
    onChange(method === "cnn1d" ? { ...next, inputMode: "raw", readings: design.method === "cnn1d" ? design.readings : 32 } : next);
  };
  const neurons = preview?.neurons ?? 0;

  return (
    <section aria-label={locked ? `Design: ${design.name}` : "Edit the design"} className="flex flex-col gap-4 rounded-lg border-2 border-foreground/70 p-3">
      <h3 className="text-base font-semibold">{locked ? design.name : design.id === "" ? "New design" : `Edit: ${design.name}`}</h3>
      {locked && <Alert role="note"><AlertDescription>This design comes with the app and cannot be changed. Use Duplicate on it to make a copy you can change.</AlertDescription></Alert>}

      <fieldset className="flex flex-col gap-4" disabled={locked || saving}>
        <div className="field">
          <div className="field-head"><Label htmlFor={`${uid}-name`} required>Name</Label></div>
          <Input id={`${uid}-name`} value={design.name} maxLength={40} onChange={(event) => set({ name: event.target.value })} />
        </div>
        <div className="field">
          <div className="field-head"><Label htmlFor={`${uid}-description`}>Description</Label></div>
          <Input id={`${uid}-description`} value={design.description} maxLength={300} placeholder="What it is for" onChange={(event) => set({ description: event.target.value })} />
        </div>

        <div className="field">
          <div className="field-head"><Label htmlFor={`${uid}-method`}>Method</Label></div>
          <select id={`${uid}-method`} className={NATIVE_SELECT} value={design.method} onChange={(event) => setMethod(event.target.value as TrainMethod)}>
            {METHODS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <p className="field-hint">{METHODS.find((option) => option.value === design.method)?.summary}</p>
        </div>

        <div className="field">
          <div className="field-head"><Label htmlFor={`${uid}-mode`}>What goes into the model</Label></div>
          <select id={`${uid}-mode`} className={NATIVE_SELECT} value={design.method === "cnn1d" ? "raw" : design.inputMode} disabled={design.method === "cnn1d"} onChange={(event) => set({ inputMode: event.target.value as "statistics" | "raw" })}>
            <option value="statistics">Statistics of each window (averages, spread, minimum, maximum…)</option>
            <option value="raw">The dataset&apos;s own columns, one input neuron each</option>
          </select>
        </div>

        {columns ? (
          <ColumnsDesigner method={design.method} columns={design.columns.length > 0 ? design.columns : ALL_COLUMNS} onColumns={(next) => set({ columns: next })} steps={design.readings} onSteps={(readings) => set({ readings })} disabled={locked || saving} />
        ) : (
          <StatisticsInputs
            sources={design.sources} onSources={(sources) => set({ sources })} lights={design.ppgChannels} onLights={(ppgChannels) => set({ ppgChannels })}
            movementOnly={design.movementOnly} onMovementOnly={(movementOnly) => set({ movementOnly })} features={design.features} onFeatures={(features) => set({ features })}
            available={preview?.available ?? []} spikeMethod={design.spikeMethod} disabled={locked || saving}
          />
        )}

        <div className="field">
          <div className="field-head"><Label htmlFor={`${uid}-spikes`}>Spike extraction</Label></div>
          <select id={`${uid}-spikes`} className={NATIVE_SELECT} value={design.spikeMethod} onChange={(event) => set({ spikeMethod: event.target.value as SpikeMethodId })}>
            {SPIKE_METHODS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <p className="field-hint">{SPIKE_METHODS.find((option) => option.value === design.spikeMethod)?.summary} Only the pulse sensor&apos;s columns are affected.</p>
        </div>

        {!columns && design.sources.includes("watchPpg") && (
          <div className="field">
            <div className="field-head"><Label htmlFor={`${uid}-baseline`}>Compare the pulse level with the recent past</Label></div>
            <select id={`${uid}-baseline`} className={NATIVE_SELECT} value={design.baselineMs ?? ""} onChange={(event) => set({ baselineMs: event.target.value === "" ? null : Number(event.target.value), features: null })}>
              {BASELINE_CHOICES.map((option) => <option key={option.label} value={option.value ?? ""}>{option.label}</option>)}
            </select>
            <p className="field-hint">
              {design.baselineMs
                ? `Adds, for each pulse channel, how far the window's average sits above the low end and the high end of the last ${design.baselineMs / 1000} seconds. A held pinch moves the sensor's level, but the level itself differs from session to session, so only the change against the recent past carries over. The model only scores once that much data has arrived, and the first ${design.baselineMs / 1000} seconds of each recording are not used. “Above its resting level” is the one to rely on for a gesture that raises the level; the other is for one that lowers it.`
                : "Off: every pulse statistic is about the window alone, so it includes the session's own level."}
            </p>
          </div>
        )}

        <div className="field">
          <div className="field-head"><Label htmlFor={`${uid}-window`}>Window length</Label></div>
          <select id={`${uid}-window`} className={NATIVE_SELECT} value={design.windowMs} onChange={(event) => set({ windowMs: Number(event.target.value) })}>
            {WINDOW_LENGTHS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {columns && design.method !== "cnn1d" && design.readings === 1 && design.spikeMethod === "none" ? (
            <p className="field-hint" role="note">With 1 reading and no spike extraction the network only sees the latest row, so the window length has almost no effect on what it reads. It only decides how the recordings are cut into examples (a window never crosses from one label to another) and how much data must have arrived before the model can score live. Choose more readings per column, or a spike extraction method, to make use of the window.</p>
          ) : (
            <p className="field-hint">How far back each example looks. {columns ? "The readings per column are spread evenly across it." : "The statistics are worked out over it."}</p>
          )}
        </div>

        {isNeural(design.method) && neurons > 0 ? (
          <NetworkDesigner method={design.method} settings={settings} onChange={(next) => onChange(withNetwork(design, next))} inputs={neurons} steps={design.method === "cnn1d" ? design.readings : 32} disabled={locked || saving} />
        ) : isNeural(design.method) ? null : (
          <p className="field-hint">Logistic regression has no layers to design: it weighs each input once. Its inputs are the whole of the design.</p>
        )}
      </fieldset>

      <div className="flex flex-col gap-2" role="status" aria-label="What this design reads">
        {preview?.problem ? (
          <Alert variant="destructive"><AlertDescription>{preview.problem}</AlertDescription></Alert>
        ) : preview ? (
          <p className="text-sm">
            {design.method === "cnn1d"
              ? <>The network reads <strong>{design.columns.length}</strong> channel{design.columns.length === 1 ? "" : "s"}, <strong>{design.readings}</strong> steps each.</>
              : columns
                ? <><strong>{design.columns.length}</strong> column{design.columns.length === 1 ? "" : "s"} × <strong>{design.readings}</strong> reading{design.readings === 1 ? "" : "s"} = <strong>{neurons} input neurons</strong>.</>
                : <>The model reads <strong>{neurons}</strong> statistic{neurons === 1 ? "" : "s"} of each window.</>}
          </p>
        ) : <p className="hint">Checking…</p>}
      </div>

      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex flex-wrap gap-2">
        {!locked && <Button type="button" disabled={saving || design.name.trim() === "" || preview === null || preview.problem !== null} onClick={onSave}>{saving ? "Saving…" : "Save design"}</Button>}
        <Button type="button" variant="outline" onClick={onCancel}>{locked ? "Close" : "Cancel"}</Button>
      </div>
    </section>
  );
}
