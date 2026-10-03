import { RotateCcwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { formatNumber, rangeHint, type NumberSpec } from "../../shared/forms/numberField";
import type { FieldState } from "../../shared/forms/useNumberDrafts";

type NumberFieldProps = {
  id: string;
  spec: NumberSpec;
  state: FieldState;
  onChange: (text: string) => void;
  onBlur: () => void;
  onResetToDefault: () => void;
  disabled?: boolean;
  /** Show the "Edited" marker on a changed field. Off where there is no saved value to differ from. */
  showEdited?: boolean;
  /** Extra detail beside the label, typically a help tooltip. */
  help?: ReactNode;
};

/**
 * A labelled numeric input for the settings forms: its unit sits inside the box, its allowed range
 * and default are stated up front rather than discovered by failing, an edited field says so, and an
 * error replaces the hint in words that say how to fix it. All of it is announced to screen readers.
 */
export function NumberField({ id, spec, state, onChange, onBlur, onResetToDefault, disabled, showEdited = true, help }: NumberFieldProps) {
  const messageId = `${id}-message`;
  const defaultText = `${formatNumber(spec.defaultValue)}${spec.unit ? ` ${spec.unit}` : ""}`;
  const invalid = state.error !== null;

  return (
    <div className="field" data-invalid={invalid || undefined} data-dirty={state.dirty || undefined}>
      <div className="field-head">
        <span className="inline-flex items-center gap-1">
          <Label htmlFor={id}>{spec.label}</Label>
          {help}
        </span>
        {showEdited && state.dirty && <span className="field-edited">Edited</span>}
      </div>
      <div className="field-control">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={state.text}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={messageId}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
        {spec.unit && <span className="field-unit" aria-hidden="true">{spec.unit}</span>}
        {state.differsFromDefault && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="field-reset"
            aria-label={`Reset ${spec.label} to its default, ${defaultText}`}
            title={`Reset to default (${defaultText})`}
            disabled={disabled}
            onClick={onResetToDefault}
          >
            <RotateCcwIcon aria-hidden="true" />
          </Button>
        )}
      </div>
      <p id={messageId} className={invalid ? "field-error" : "field-hint"} aria-live="polite">
        {state.error ?? (spec.description ? `${spec.description}. ${rangeHint(spec)}` : rangeHint(spec))}
        {!invalid && <span className="field-default"> · default {defaultText}</span>}
      </p>
    </div>
  );
}
