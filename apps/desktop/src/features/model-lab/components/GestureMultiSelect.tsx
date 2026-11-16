import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { LabelSwatch } from "../../labels/labelColor";
import type { DatasetLabel } from "../types";

/**
 * A dropdown of labels where several can be ticked, in the order they were ticked: the first is the one the rest are
 * named after (Train's target). Closed, it shows the chosen labels; open, a list of every label with a tick. Escape or a
 * click elsewhere closes it.
 */
export function GestureMultiSelect({ label, options, value, onChange, disabled, placeholder = "Choose…", catalogue }: {
  /** The field's name, for the button and the list. */
  label: string;
  options: { id: string; displayName: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /** For each label's colour swatch. */
  catalogue: DatasetLabel[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const nameOf = (id: string) => options.find((option) => option.id === id)?.displayName ?? id.replaceAll("_", " ");

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div ref={root} className="multi-select">
      <button type="button" className="recipe-select multi-select-button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        disabled={disabled} onClick={() => setOpen((was) => !was)}>
        <span className="multi-select-value">
          {value.length === 0
            ? <span className="text-muted-foreground">{placeholder}</span>
            : value.map((id) => <span key={id} className="multi-select-chip"><LabelSwatch label={id} catalogue={catalogue} />{nameOf(id)}</span>)}
        </span>
        <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
      </button>
      {open && (
        <ul id={listId} role="listbox" aria-multiselectable="true" aria-label={label} className="multi-select-list">
          {options.length === 0 && <li className="multi-select-empty">Nothing to choose yet.</li>}
          {options.map((option) => {
            const chosen = value.includes(option.id);
            return (
              <li key={option.id} role="option" aria-selected={chosen} tabIndex={0} className="multi-select-option"
                onClick={() => toggle(option.id)}
                onKeyDown={(event) => {
                  if (event.key === " " || event.key === "Enter") {
                    event.preventDefault();
                    toggle(option.id);
                  }
                }}>
                <span className="multi-select-tick" aria-hidden="true">{chosen && <Check className="size-3.5" />}</span>
                <LabelSwatch label={option.id} catalogue={catalogue} />
                {option.displayName}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
