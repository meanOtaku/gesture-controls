import { ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/button";

export interface FloatingMenuItem {
  label: string;
  run: () => void;
  disabled?: boolean;
  /** Shown in the destructive colour (archive, delete). */
  danger?: boolean;
}

/**
 * A button that opens a short list of actions over the page, anchored under it (right-aligned), so opening it moves
 * nothing. Escape, a click elsewhere or choosing an item closes it. Drawn in a portal, so a card that hides what
 * overflows it cannot cut it off.
 */
export function FloatingMenu({ label, ariaLabel, items, disabled }: { label: string; ariaLabel: string; items: FloatingMenuItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const at = button.current?.getBoundingClientRect();
      if (at) setPlace({ top: at.bottom + 2, right: window.innerWidth - at.right });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !list.current?.contains(target)) setOpen(false);
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

  if (items.length === 0) return null;
  return (
    <>
      <Button ref={button} type="button" variant="ghost" size="sm" aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
        disabled={disabled} onClick={() => setOpen((was) => !was)}>
        {label} <ChevronDown className="size-3.5" aria-hidden="true" />
      </Button>
      {open && createPortal(
        <div ref={list} id={id} role="menu" aria-label={ariaLabel} className="floating-menu"
          style={place ? { position: "fixed", top: place.top, right: place.right } : { visibility: "hidden" }}>
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" className={`floating-menu-item${item.danger ? " floating-menu-danger" : ""}`}
              disabled={item.disabled} onClick={() => { setOpen(false); item.run(); }}>
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
