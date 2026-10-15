import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useThemeIs } from "../../shared/theme/useThemeIs";

interface Choice {
  value: string;
  label: string;
  disabled: boolean;
  /** The <optgroup> label when this option starts a new group, so the list can show the heading above it. */
  groupStart: string | null;
}

interface OpenMenu {
  select: HTMLSelectElement;
  choices: Choice[];
  active: number;
}

const GAP = 2;
const MAX_HEIGHT = 320;
const TYPE_AHEAD_MS = 700;
const OPEN_KEYS = new Set([" ", "Enter", "ArrowDown", "ArrowUp"]);

/** A one-line dropdown we can replace: not a list box, not multiple, not disabled. */
const replaceable = (target: EventTarget | null): target is HTMLSelectElement =>
  target instanceof HTMLSelectElement && !target.multiple && target.size <= 1 && !target.disabled;

function readChoices(select: HTMLSelectElement): Choice[] {
  return Array.from(select.options).map((option) => {
    const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
    return {
      value: option.value,
      label: option.label || option.text,
      disabled: option.disabled || group?.disabled === true,
      groupStart: group && group.firstElementChild === option ? group.label : null,
    };
  });
}

/** The next choice that can be picked from `from` in `step` direction, or `from` when there is none. */
function nextEnabled(choices: Choice[], from: number, step: 1 | -1): number {
  for (let i = from + step; i >= 0 && i < choices.length; i += step) if (!choices[i].disabled) return i;
  return from;
}

/** Picks `value` on the real <select> and tells React and anything else listening, as a person choosing it would. */
function choose(select: HTMLSelectElement, value: string) {
  if (select.value !== value) {
    select.value = value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  select.focus();
}

/**
 * The NERV theme's list for native dropdowns. The option list of a <select> is drawn by the operating system and
 * cannot be styled, so under NERV a dropdown opened by pointer or keyboard shows this themed list instead. The
 * <select> stays the real control: the list reads its options, and a choice is set on it and announced with the usual
 * input and change events, so every dropdown in the app works unchanged. Other themes keep the system list.
 */
export function NervSelectMenu() {
  const nerv = useThemeIs("nerv");
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [place, setPlace] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();
  const optionId = (index: number) => `${id}-option-${index}`;

  const open = useCallback((select: HTMLSelectElement) => {
    const choices = readChoices(select);
    if (choices.length === 0) return;
    const selected = select.selectedIndex;
    const active = selected >= 0 && !choices[selected]?.disabled ? selected : nextEnabled(choices, -1, 1);
    select.focus();
    setMenu({ select, choices, active });
  }, []);

  const close = useCallback((refocus: boolean) => {
    setMenu((current) => {
      if (current && refocus) current.select.focus();
      return null;
    });
  }, []);

  // Opening: a press on a dropdown, or the keys that would open the system list.
  useEffect(() => {
    if (!nerv) return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.button !== 0 || !replaceable(event.target)) return;
      event.preventDefault();
      const select = event.target;
      setMenu((current) => (current?.select === select ? null : current));
      if (menu?.select !== select) open(select);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (menu || !replaceable(event.target) || !OPEN_KEYS.has(event.key) || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      open(event.target);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [nerv, menu, open]);

  // While open: keys move through the list; a press elsewhere, scrolling the page or resizing closes it.
  useEffect(() => {
    if (!menu) return;
    const { select, choices } = menu;
    const move = (to: number) => setMenu((current) => (current ? { ...current, active: to } : current));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey) return;
      const handled = () => { event.preventDefault(); event.stopPropagation(); };
      switch (event.key) {
        case "ArrowDown": handled(); move(event.altKey ? nextEnabled(choices, choices.length, -1) : nextEnabled(choices, menu.active, 1)); return;
        case "ArrowUp": handled(); move(event.altKey ? nextEnabled(choices, -1, 1) : nextEnabled(choices, menu.active, -1)); return;
        case "Home": case "PageUp": handled(); move(nextEnabled(choices, -1, 1)); return;
        case "End": case "PageDown": handled(); move(nextEnabled(choices, choices.length, -1)); return;
        case "Enter": case " ":
          handled();
          if (!choices[menu.active]?.disabled) choose(select, choices[menu.active].value);
          close(true);
          return;
        case "Escape": handled(); close(true); return;
        case "Tab": close(false); return;
      }
      if (event.key.length === 1 && !event.altKey) {
        handled();
        const now = Date.now();
        typed.current = { text: (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : "") + event.key.toLowerCase(), at: now };
        const text = typed.current.text;
        const order = [...choices.keys()].map((i) => (menu.active + (text.length === 1 ? 1 : 0) + i) % choices.length);
        const hit = order.find((i) => !choices[i].disabled && choices[i].label.toLowerCase().startsWith(text));
        if (hit !== undefined) move(hit);
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (listRef.current?.contains(target) || target === select) return;
      close(false);
    };
    const onScroll = (event: Event) => { if (!listRef.current?.contains(event.target as Node)) close(false); };
    const onResize = () => close(false);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [menu, close]);

  // Tell assistive technology the dropdown is open and which option is lit, on the real control.
  useEffect(() => {
    if (!menu) return;
    const { select } = menu;
    select.setAttribute("aria-expanded", "true");
    select.setAttribute("aria-controls", `${id}-list`);
    select.setAttribute("aria-activedescendant", optionId(menu.active));
    return () => {
      select.removeAttribute("aria-expanded");
      select.removeAttribute("aria-controls");
      select.removeAttribute("aria-activedescendant");
    };
  });

  // Under the dropdown when there is room, above it when there is more room there.
  useLayoutEffect(() => {
    if (!menu) { setPlace(null); return; }
    const rect = menu.select.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - GAP - 8;
    const above = rect.top - GAP - 8;
    const flip = below < Math.min(MAX_HEIGHT, 160) && above > below;
    setPlace({
      left: rect.left,
      width: rect.width,
      ...(flip ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
      maxHeight: Math.max(80, Math.min(MAX_HEIGHT, flip ? above : below)),
    });
  }, [menu?.select]);

  useEffect(() => {
    if (menu) document.getElementById(optionId(menu.active))?.scrollIntoView({ block: "nearest" });
  }, [menu?.active]);

  if (!nerv || !menu || !place) return null;
  const selected = menu.select.selectedIndex;
  return createPortal(
    <div
      ref={listRef}
      id={`${id}-list`}
      className="nerv-select-menu"
      role="listbox"
      aria-label={menu.select.getAttribute("aria-label") ?? menu.select.labels?.[0]?.textContent ?? undefined}
      style={{ left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}
      data-side={place.top === undefined ? "top" : "bottom"}
    >
      {menu.choices.map((choice, index) => (
        <div key={index} role="presentation">
          {choice.groupStart !== null && <div className="nerv-select-group" role="presentation">{choice.groupStart}</div>}
          <div
            id={optionId(index)}
            role="option"
            className="nerv-select-option"
            aria-selected={index === selected}
            aria-disabled={choice.disabled || undefined}
            data-active={index === menu.active || undefined}
            onMouseMove={() => { if (!choice.disabled && menu.active !== index) setMenu({ ...menu, active: index }); }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (choice.disabled) return;
              choose(menu.select, choice.value);
              close(true);
            }}
          >
            {choice.label}
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}
