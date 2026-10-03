import { useCallback, useMemo, useRef, useState } from "react";
import { formatNumber, parseNumber, type NumberSpec } from "./numberField";

export interface FieldState {
  /** What is in the input right now. */
  text: string;
  /** Differs from the saved value. */
  dirty: boolean;
  /** The message to show, once the user has left the field or tried to submit; otherwise null. */
  error: string | null;
  /** Differs from the field's default. */
  differsFromDefault: boolean;
}

export interface NumberDrafts<K extends string> {
  fields: Record<K, FieldState>;
  setText: (key: K, text: string) => void;
  /** The user left the field: from now on its error (if any) is shown. */
  touch: (key: K) => void;
  /** Put the field back to its default value (as an edit; it still has to be applied). */
  resetToDefault: (key: K) => void;
  /** Throw away every edit. */
  discard: () => void;
  dirtyCount: number;
  /** How many dirty fields are invalid, shown or not. */
  invalidCount: number;
  /**
   * Validates everything. Returns every field's value (the saved one for an untouched field, the
   * parsed one for an edited field), or null with the first invalid key, and from then on shows all errors.
   */
  submit: () => { values: Record<K, number> } | { values: null; firstInvalid: K };
}

const keysOf = <K extends string>(record: Record<K, unknown>): K[] => Object.keys(record) as K[];

/**
 * Draft state for a group of numeric fields that are edited freely and saved together.
 *
 * Text is held as typed. Nothing is repaired behind the user's back: an invalid field keeps what was
 * typed and says what is wrong. When a field's saved value changes (an apply, a reset, a change made
 * elsewhere) only that field's text follows it, so a half-typed value in another field is not lost.
 */
export function useNumberDrafts<K extends string>(
  specs: Record<K, NumberSpec>,
  committed: Record<K, number>,
): NumberDrafts<K> {
  const keys = useMemo(() => keysOf(specs), [specs]);
  const seed = useCallback(
    () => Object.fromEntries(keys.map((key) => [key, formatNumber(committed[key])])) as Record<K, string>,
    [keys, committed],
  );

  const [text, setTextState] = useState<Record<K, string>>(seed);
  const [touched, setTouched] = useState<ReadonlySet<K>>(new Set());
  const [submitted, setSubmitted] = useState(false);

  // Follow saved values that changed since last render, field by field. Done during render (the
  // React-documented way to adjust state from props) so there is no frame showing stale text.
  const lastCommitted = useRef<Record<K, number>>(committed);
  const changed = keys.filter((key) => committed[key] !== lastCommitted.current[key]);
  if (changed.length > 0) {
    lastCommitted.current = committed;
    setTextState((previous) => {
      const next = { ...previous };
      for (const key of changed) next[key] = formatNumber(committed[key]);
      return next;
    });
    setTouched((previous) => {
      const next = new Set(previous);
      for (const key of changed) next.delete(key);
      return next;
    });
  }

  const fields = useMemo(() => {
    const result = {} as Record<K, FieldState>;
    for (const key of keys) {
      const spec = specs[key];
      const value = text[key];
      const dirty = value !== formatNumber(committed[key]);
      const parsed = dirty ? parseNumber(value, spec) : null;
      const show = dirty && (submitted || touched.has(key));
      result[key] = {
        text: value,
        dirty,
        error: show && parsed && !parsed.ok ? parsed.message : null,
        differsFromDefault: value !== formatNumber(spec.defaultValue),
      };
    }
    return result;
  }, [keys, specs, text, committed, submitted, touched]);

  const dirtyKeys = keys.filter((key) => fields[key].dirty);
  const invalidKeys = dirtyKeys.filter((key) => !parseNumber(text[key], specs[key]).ok);

  const setText = useCallback((key: K, value: string) => setTextState((previous) => ({ ...previous, [key]: value })), []);
  const touch = useCallback((key: K) => setTouched((previous) => (previous.has(key) ? previous : new Set(previous).add(key))), []);
  const resetToDefault = useCallback(
    (key: K) => {
      setTextState((previous) => ({ ...previous, [key]: formatNumber(specs[key].defaultValue) }));
      setTouched((previous) => new Set(previous).add(key));
    },
    [specs],
  );
  const discard = useCallback(() => {
    setTextState(seed());
    setTouched(new Set());
    setSubmitted(false);
  }, [seed]);

  const submit = useCallback(() => {
    setSubmitted(true);
    const values = {} as Record<K, number>;
    for (const key of keys) {
      if (text[key] === formatNumber(committed[key])) {
        values[key] = committed[key]; // untouched: keep the exact saved value, not its rounded text
        continue;
      }
      const parsed = parseNumber(text[key], specs[key]);
      if (!parsed.ok) return { values: null, firstInvalid: key } as const;
      values[key] = parsed.value;
    }
    return { values } as const;
  }, [keys, text, committed, specs]);

  return { fields, setText, touch, resetToDefault, discard, dirtyCount: dirtyKeys.length, invalidCount: invalidKeys.length, submit };
}
