import { Fragment } from "react";
import { Checkbox } from "../../../components/ui/checkbox";
import { ALL_PPG_CHANNELS, PPG_CHANNELS, SPIKE_METHODS, STREAMS, type DataStream, type PpgChannel, type SpikeMethodId } from "../training";
import { InputPicker } from "./InputPicker";

/**
 * What the model reads when it reads statistics: the streams, which of the pulse sensor's lights, only how things change, and
 * (optionally) exactly which statistics. `available` is every statistic the choices provide, from the desktop.
 */
export function StatisticsInputs({
  sources, onSources, lights, onLights, movementOnly, onMovementOnly, features, onFeatures, available, spikeMethod, disabled,
}: {
  sources: DataStream[];
  onSources: (next: DataStream[]) => void;
  /** Null means all three lights. */
  lights: PpgChannel[] | null;
  onLights: (next: PpgChannel[] | null) => void;
  movementOnly: boolean;
  onMovementOnly: (next: boolean) => void;
  features: string[] | null;
  onFeatures: (next: string[] | null) => void;
  available: string[];
  spikeMethod: SpikeMethodId;
  disabled?: boolean;
}) {
  const chosenLights = lights ?? ALL_PPG_CHANNELS;
  const toggleSource = (stream: DataStream) => onSources(sources.includes(stream) ? sources.filter((s) => s !== stream) : [...sources, stream]);
  const toggleLight = (light: PpgChannel) => {
    const next = chosenLights.includes(light) ? chosenLights.filter((l) => l !== light) : [...chosenLights, light];
    const ordered = ALL_PPG_CHANNELS.filter((l) => next.includes(l)); // always at least one, in the sensor's order
    onLights(ordered.length === 0 ? chosenLights : ordered.length === ALL_PPG_CHANNELS.length ? null : ordered);
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="label">What the model may read</legend>
      <ul className="flex flex-col gap-1" aria-label="Data the model may read">
        {STREAMS.map((stream) => (
          <Fragment key={stream.value}>
            <li className="flex items-start gap-2 text-sm">
              <Checkbox checked={sources.includes(stream.value)} disabled={disabled} onCheckedChange={() => toggleSource(stream.value)} aria-label={stream.label} />
              <span><strong>{stream.label}</strong> <small className="text-muted-foreground">{stream.summary}</small></span>
            </li>
            {stream.value === "watchPpg" && sources.includes("watchPpg") && (
              <li className="ml-7">
                <ul className="flex flex-col gap-1" aria-label="Pulse sensor channels the model may read">
                  {PPG_CHANNELS.map((channel) => (
                    <li key={channel.value} className="flex items-start gap-2 text-sm">
                      <Checkbox checked={chosenLights.includes(channel.value)} disabled={disabled || (chosenLights.length === 1 && chosenLights[0] === channel.value)} onCheckedChange={() => toggleLight(channel.value)} aria-label={`Pulse channel: ${channel.label}`} />
                      <span><strong>{channel.label}</strong> <small className="text-muted-foreground">{channel.summary}</small></span>
                    </li>
                  ))}
                </ul>
              </li>
            )}
          </Fragment>
        ))}
      </ul>
      <InputPicker available={available} chosen={features} onChange={onFeatures} spikeMethodLabel={spikeMethod === "none" ? undefined : SPIKE_METHODS.find((o) => o.value === spikeMethod)?.label} disabled={disabled} />
      <div className="flex items-start gap-2 text-sm">
        <Checkbox checked={movementOnly} disabled={disabled} onCheckedChange={() => onMovementOnly(!movementOnly)} aria-label="Only how things change" />
        <span><strong>Only how things change</strong> <small className="text-muted-foreground">Ignore absolute levels such as how the watch is held. This stops a model from memorising a session&apos;s posture; try it for movement gestures.</small></span>
      </div>
    </fieldset>
  );
}
