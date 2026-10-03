import { RadioGroup, RadioGroupItem } from "../ui/radio-group";

export interface SegmentOption<V extends string> {
  value: V;
  /** The text shown on the segment. */
  label: string;
  /** The accessible name, when it should say more than the visible text. */
  ariaLabel?: string;
}

type SegmentedControlProps<V extends string> = {
  value: V;
  onValueChange: (value: V) => void;
  options: ReadonlyArray<SegmentOption<V>>;
  /** Id of the element that names this group (a visible field label). */
  labelledBy: string;
  disabled?: boolean;
};

/**
 * A short either/or choice shown as joined segments, the chosen one filled. It is a radio group
 * underneath, so the arrow keys move the choice, a screen reader announces "radio, 1 of 2", and the
 * whole segment (not a small dot) is the click target.
 */
export function SegmentedControl<V extends string>({
  value,
  onValueChange,
  options,
  labelledBy,
  disabled,
}: SegmentedControlProps<V>) {
  return (
    <RadioGroup
      className="segmented"
      aria-labelledby={labelledBy}
      value={value}
      disabled={disabled}
      onValueChange={(next) => onValueChange(next as V)}
    >
      {options.map((option) => (
        <label key={option.value} className="segment">
          <RadioGroupItem className="segment-input" value={option.value} aria-label={option.ariaLabel ?? option.label} />
          <span>{option.label}</span>
        </label>
      ))}
    </RadioGroup>
  );
}
