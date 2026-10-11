import { Checkbox } from "../../../components/ui/checkbox";
import { Button } from "../../../components/ui/button";
import { STREAM_TITLES, groupInputs } from "../featureInfo";

/**
 * Choose exactly which inputs the model reads, out of the ones the chosen streams and settings provide. Each is named
 * with what it is (hover or focus for the full description). `chosen` null means all of them.
 */
export function InputPicker({
  available, chosen, onChange, spikeMethodLabel, disabled, channels,
}: {
  available: string[];
  chosen: string[] | null;
  onChange: (next: string[] | null) => void;
  /** The Spike extraction method's name, for the description of the spike inputs. */
  spikeMethodLabel?: string;
  disabled?: boolean;
  /** The convolutional method reads channels, not statistics. */
  channels?: boolean;
}) {
  if (available.length === 0) return null;
  const current = new Set(chosen ?? available);
  const count = available.filter((name) => current.has(name)).length;
  const commit = (next: Set<string>) => {
    const ordered = available.filter((name) => next.has(name));
    onChange(ordered.length === available.length ? null : ordered);
  };
  const toggle = (name: string) => {
    const next = new Set(current);
    if (next.has(name)) {
      if (next.size > 1) next.delete(name); // never none
    } else next.add(name);
    commit(next);
  };
  const setMany = (names: string[], on: boolean) => {
    const next = new Set(current);
    for (const name of names) {
      if (on) next.add(name);
      else if (next.size > 1) next.delete(name);
    }
    commit(next);
  };
  const grouped = groupInputs(available, spikeMethodLabel);

  return (
    <details className="rounded-lg border border-input px-3 py-2" aria-label="Choose individual inputs">
      <summary className="cursor-pointer text-sm font-semibold">
        Choose individual {channels ? "channels" : "inputs"} <span className="font-normal text-muted-foreground">({count} of {available.length} used)</span>
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        <p className="field-hint">
          The model reads only the {channels ? "channels" : "inputs"} ticked here. Hover or focus one to see exactly what it takes as its value. Leaving all ticked reads everything the streams above provide.
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled || count === available.length} onClick={() => onChange(null)}>Use all</Button>
        </div>
        {grouped.map(({ stream, groups }) => {
          const names = groups.flatMap((g) => g.inputs.map((i) => i.name));
          return (
            <fieldset key={stream} className="flex flex-col gap-1">
              <legend className="label flex items-center gap-2">
                {STREAM_TITLES[stream]}
                <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setMany(names, true)}>All</Button>
                <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setMany(names, false)}>None</Button>
              </legend>
              <ul className="flex flex-col gap-1" aria-label={`${STREAM_TITLES[stream]} inputs`}>
                {groups.map(({ group, inputs }) => (
                  <li key={group} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <span className="min-w-24 font-medium">{group}</span>
                    {inputs.map((input) => (
                      <span key={input.name} className="inline-flex items-center gap-1" title={input.text}>
                        <Checkbox checked={current.has(input.name)} disabled={disabled} onCheckedChange={() => toggle(input.name)} aria-label={`${STREAM_TITLES[stream]} ${group} ${input.short}`} aria-description={input.text} />
                        {input.short}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </fieldset>
          );
        })}
      </div>
    </details>
  );
}
