import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LabelSwatch } from "../../labels/labelColor";
import type { DatasetLabel } from "../types";

/**
 * A dropdown of labels where several can be ticked, in the order they were ticked: the first is the one the rest are
 * named after (Train's target). Closed, it shows the chosen labels; open, a list of every label with a tick. Escape or a
 * click elsewhere closes it. The list is drawn over the page (in a portal, placed under the button), so a card that hides
 * what overflows it cannot cut it off.
 */
export function GestureMultiSelect({ label, options, value, onChange, disabled, placeholder = "Choose…", catalogue }: {
  /** The field's name, for the button and the list. */
  label: string;
  /** In order; `depth` 1 indents an option under the one before (a gesture's phase under the gesture). */
  options: { id: string; displayName: string; depth?: number }[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /** For each label's colour swatch. */
  catalogue: DatasetLabel[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Where the list goes: under the button, as wide as it, above it when there is no room below.
  const [place, setPlace] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const button = root.current?.getBoundingClientRect();
      if (!button) return;
      const below = window.innerHeight - button.bottom - 8;
      const above = button.top - 8;
      const wanted = 288;
      setPlace(below >= Math.min(wanted, above)
        ? { left: button.left, width: button.width, top: button.bottom + 2, maxHeight: Math.max(120, Math.min(wanted, below)) }
        : { left: button.left, width: button.width, bottom: window.innerHeight - button.top + 2, maxHeight: Math.max(120, Math.min(wanted, above)) });
    };
    measure();
    window.addEventListener("resize", measure);
    // Any scrolling container moving the button moves the list with it.
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);
  const listId = useId();
  const nameOf = (id: string) => options.find((option) => option.id === id)?.displayName ?? id.replaceAll("_", " ");

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !list.current?.contains(target)) setOpen(false);
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
      {open && createPortal(
        <ul ref={list} id={listId} role="listbox" aria-multiselectable="true" aria-label={label} className="multi-select-list"
          style={place ? { position: "fixed", left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight, right: "auto" } : { visibility: "hidden" }}>
          {options.length === 0 && <li className="multi-select-empty">Nothing to choose yet.</li>}
          {options.map((option) => {
            const chosen = value.includes(option.id);
            return (
              <li key={option.id} role="option" aria-selected={chosen} tabIndex={0} className={`multi-select-option${option.depth ? " multi-select-option-nested" : ""}`}
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
        </ul>,
        document.body,
      )}
    </div>
  );
}
