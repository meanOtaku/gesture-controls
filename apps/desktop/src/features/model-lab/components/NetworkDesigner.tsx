import { PlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useId } from "react";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import {
  ACTIVATIONS, KERNELS, LIMITS, POOLINGS, appliesTo, clamp, defaultNetwork, parameterCount, sameNetwork,
  type Activation, type ConvLayer, type DenseLayer, type NetworkSettings, type Pooling,
} from "../network";
import type { TrainMethod } from "../training";
import { NetworkDiagram } from "./NetworkDiagram";

const NATIVE_SELECT = "recipe-select";
const number = (text: string, fallback: number) => (text.trim() === "" || Number.isNaN(Number(text)) ? fallback : Number(text));
const formatCount = (value: number) => value.toLocaleString("en-US");

/**
 * Design the network: its layers, neurons, activations and how it learns, with a picture and the number of parameters
 * updating as you go. Anything not changed keeps the method's own default, and nothing is sent until it differs.
 */
export function NetworkDesigner({
  method, settings, onChange, inputs, steps, disabled,
}: {
  method: TrainMethod;
  settings: NetworkSettings;
  onChange: (next: NetworkSettings) => void;
  /** How many inputs the model reads (statistics, or for the convolutional method, channels). */
  inputs: number;
  /** The convolutional method's steps per channel. */
  steps: number;
  disabled?: boolean;
}) {
  const uid = useId();
  const use = appliesTo(method);
  const patch = (change: Partial<NetworkSettings>) => onChange({ ...settings, ...change });
  const parameters = parameterCount(settings, inputs, method);
  const isDefault = sameNetwork(settings, defaultNetwork(method));

  const setHidden = (index: number, change: Partial<DenseLayer>) => patch({ hidden: settings.hidden.map((layer, i) => (i === index ? { ...layer, ...change } : layer)) });
  const setConv = (index: number, change: Partial<ConvLayer>) => patch({ conv: settings.conv.map((layer, i) => (i === index ? { ...layer, ...change } : layer)) });
  const activationSelect = (label: string, value: Activation, onPick: (a: Activation) => void) => (
    <select aria-label={label} className={NATIVE_SELECT} value={use.activations ? value : "relu"} disabled={disabled || !use.activations} onChange={(event) => onPick(event.target.value as Activation)}>
      {ACTIVATIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );

  return (
    <fieldset className="flex flex-col gap-3" aria-label="Network design">
      <legend className="label">Network</legend>
      <NetworkDiagram settings={settings} inputs={inputs} method={method} steps={steps} />
      <p className="field-hint" role="status">
        {inputs} input{inputs === 1 ? "" : "s"} → {method === "cnn1d" ? "convolution → " : ""}{settings.hidden.map((layer) => `${layer.units} → `).join("")}2 outputs · <strong>{formatCount(parameters)} parameters</strong>.
        {parameters > 5000 && " That is a lot of numbers to learn from a few recordings; a smaller network is safer, or record more sessions."}
        {!use.activations && " The scikit-learn network always uses ReLU, and takes only the layer sizes and the number of rounds."}
      </p>

      {use.conv && (
        <div className="flex flex-col gap-2">
          <span className="label">Convolution layers</span>
          <ul className="flex flex-col gap-2" aria-label="Convolution layers">
            {settings.conv.map((layer, index) => (
              <li key={index} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-16">Layer {index + 1}</span>
                <label className="flex items-center gap-1">Filters
                  <Input type="number" className="w-20" aria-label={`Filters in convolution layer ${index + 1}`} min={1} max={LIMITS.filters} value={layer.filters} disabled={disabled} onChange={(e) => setConv(index, { filters: Math.round(clamp(number(e.target.value, layer.filters), [1, LIMITS.filters])) })} />
                </label>
                <label className="flex items-center gap-1">Width
                  <select aria-label={`Width of convolution layer ${index + 1}`} className={NATIVE_SELECT} value={layer.kernel} disabled={disabled} onChange={(e) => setConv(index, { kernel: Number(e.target.value) })}>
                    {KERNELS.map((kernel) => <option key={kernel} value={kernel}>{kernel} steps</option>)}
                  </select>
                </label>
                {activationSelect(`Activation of convolution layer ${index + 1}`, layer.activation, (activation) => setConv(index, { activation }))}
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove convolution layer ${index + 1}`} disabled={disabled || settings.conv.length <= 1} onClick={() => patch({ conv: settings.conv.filter((_, i) => i !== index) })}><Trash2Icon aria-hidden="true" /></Button>
              </li>
            ))}
          </ul>
          <div>
            <Button type="button" variant="outline" size="sm" disabled={disabled || settings.conv.length >= LIMITS.convLayers} onClick={() => patch({ conv: [...settings.conv, { filters: 16, kernel: 5, activation: "relu" }] })}><PlusIcon aria-hidden="true" />Add convolution layer</Button>
          </div>
          <div className="field">
            <div className="field-head"><Label htmlFor={`${uid}-pool`}>Pooling over time</Label></div>
            <select id={`${uid}-pool`} className={NATIVE_SELECT} value={settings.pooling} disabled={disabled} onChange={(e) => patch({ pooling: e.target.value as Pooling })}>
              {POOLINGS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <p className="field-hint">How each filter&apos;s answers across the window are boiled down: the average says how much of the pattern there is, the maximum whether it appears anywhere.</p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="label">{use.conv ? "Dense layers after the pooling" : "Hidden layers"}</span>
        {settings.hidden.length === 0 && <p className="field-hint">None: the {use.conv ? "pooled values go" : "inputs go"} straight to the two outputs.</p>}
        <ul className="flex flex-col gap-2" aria-label="Hidden layers">
          {settings.hidden.map((layer, index) => (
            <li key={index} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-16">Layer {index + 1}</span>
              <label className="flex items-center gap-1">Neurons
                <Input type="number" className="w-20" aria-label={`Neurons in layer ${index + 1}`} min={1} max={LIMITS.units} value={layer.units} disabled={disabled} onChange={(e) => setHidden(index, { units: Math.round(clamp(number(e.target.value, layer.units), [1, LIMITS.units])) })} />
              </label>
              {activationSelect(`Activation of layer ${index + 1}`, layer.activation, (activation) => setHidden(index, { activation }))}
              <Button type="button" variant="ghost" size="sm" aria-label={`Remove layer ${index + 1}`} disabled={disabled || (!use.conv && settings.hidden.length <= 1)} onClick={() => patch({ hidden: settings.hidden.filter((_, i) => i !== index) })}><Trash2Icon aria-hidden="true" /></Button>
            </li>
          ))}
        </ul>
        <div>
          <Button type="button" variant="outline" size="sm" disabled={disabled || settings.hidden.length >= LIMITS.hiddenLayers} onClick={() => patch({ hidden: [...settings.hidden, { units: 16, activation: "relu" }] })}><PlusIcon aria-hidden="true" />Add layer</Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="field">
          <div className="field-head"><Label htmlFor={`${uid}-epochs`}>{method === "mlp" ? "Most rounds" : "Rounds"}</Label></div>
          <Input id={`${uid}-epochs`} type="number" min={LIMITS.epochs[0]} max={LIMITS.epochs[1]} value={settings.epochs} disabled={disabled} onChange={(e) => patch({ epochs: Math.round(clamp(number(e.target.value, settings.epochs), LIMITS.epochs)) })} />
          <p className="field-hint">How many times it goes over the training windows{method === "mlp" ? " (it stops sooner if it stops improving)" : ""}.</p>
        </div>
        {use.learningRate && (
          <div className="field">
            <div className="field-head"><Label htmlFor={`${uid}-lr`}>Learning rate</Label></div>
            <Input id={`${uid}-lr`} type="number" step="0.001" min={LIMITS.learningRate[0]} max={LIMITS.learningRate[1]} value={settings.learningRate} disabled={disabled} onChange={(e) => patch({ learningRate: clamp(number(e.target.value, settings.learningRate), LIMITS.learningRate) })} />
            <p className="field-hint">How big each step is. Too high and it never settles; too low and it takes forever.</p>
          </div>
        )}
        {use.batchSize && (
          <div className="field">
            <div className="field-head"><Label htmlFor={`${uid}-batch`}>Batch size</Label></div>
            <Input id={`${uid}-batch`} type="number" min={0} max={LIMITS.batch} value={settings.batchSize} disabled={disabled} onChange={(e) => patch({ batchSize: Math.round(clamp(number(e.target.value, settings.batchSize), [0, LIMITS.batch])) })} />
            <p className="field-hint">Windows per step. 0 uses all of them every step.</p>
          </div>
        )}
        {use.weightDecay && (
          <div className="field">
            <div className="field-head"><Label htmlFor={`${uid}-decay`}>Weight decay</Label></div>
            <Input id={`${uid}-decay`} type="number" step="0.0005" min={LIMITS.weightDecay[0]} max={LIMITS.weightDecay[1]} value={settings.weightDecay} disabled={disabled} onChange={(e) => patch({ weightDecay: clamp(number(e.target.value, settings.weightDecay), LIMITS.weightDecay) })} />
            <p className="field-hint">Pulls the weights toward zero, which discourages memorising.</p>
          </div>
        )}
        {use.dropout && (
          <div className="field">
            <div className="field-head"><Label htmlFor={`${uid}-dropout`}>Dropout</Label></div>
            <Input id={`${uid}-dropout`} type="number" step="0.05" min={LIMITS.dropout[0]} max={LIMITS.dropout[1]} value={settings.dropout} disabled={disabled} onChange={(e) => patch({ dropout: clamp(number(e.target.value, settings.dropout), LIMITS.dropout) })} />
            <p className="field-hint">The share of the last layer&apos;s inputs switched off at random while training. Never when the model runs.</p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {use.balanceClasses && (
          <div className="flex items-start gap-2 text-sm">
            <Checkbox checked={settings.balanceClasses} disabled={disabled} onCheckedChange={() => patch({ balanceClasses: !settings.balanceClasses })} aria-label="Balance the classes" />
            <span><strong>Balance the classes</strong> <small className="text-muted-foreground">Count the rarer of the gesture and everything else for more, so a long recording of one does not drown out the other.</small></span>
          </div>
        )}
        {use.augment && (
          <div className="flex items-start gap-2 text-sm">
            <Checkbox checked={settings.augment} disabled={disabled} onCheckedChange={() => patch({ augment: !settings.augment })} aria-label="Shift, scale and add noise while training" />
            <span><strong>Shift, scale and add noise while training</strong> <small className="text-muted-foreground">Trains on slightly changed copies of the windows, so a few recordings are not simply memorised.</small></span>
          </div>
        )}
      </div>

      <div>
        <Button type="button" variant="outline" size="sm" disabled={disabled || isDefault} onClick={() => onChange(defaultNetwork(method))}><RotateCcwIcon aria-hidden="true" />Reset to the method&apos;s defaults</Button>
      </div>
    </fieldset>
  );
}
