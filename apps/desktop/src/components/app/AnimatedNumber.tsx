import NumberFlow, { type Format } from "@number-flow/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * The quickest a number moves on to a newer value. A live reading arriving several times a second is held for this long
 * between rolls; NumberFlow carries a roll that is still turning on to the newer value, so it keeps moving without lagging far behind.
 */
const STEP_MS = 250;

const inTest = (import.meta as { env?: { MODE?: string } }).env?.MODE === "test";

/** The number as it was written before it rolled: `toFixed` with `digits`, or the plain number without. */
const plain = (value: number, digits: number | undefined) => (digits === undefined ? String(value) : value.toFixed(digits));

type AnimatedNumberProps = {
  value: number;
  /** Decimal places, as `toFixed` takes them. Without it the number is shown as it is. */
  digits?: number;
  /** Digits before the decimal point at least, for a part of a time such as the 07 of 07:20. */
  integerDigits?: number;
  /** Anything else `Intl.NumberFormat` can do, in place of `digits`. */
  format?: Format;
};

/**
 * A number that rolls (NumberFlow): up from zero when it first appears, then to each new value. A value that changes
 * faster than a roll takes is shown at most every [`STEP_MS`], always ending on the latest. It reads to a screen reader as
 * the plain number and stands still for anyone who asked for reduced motion.
 *
 * Two cases are shown as plain text instead: a value that is not a finite number (so "NaN" stays "NaN"), and every value
 * under test, so a sentence with a number in it can still be found whole.
 */
export function AnimatedNumber({ value, digits, integerDigits, format }: AnimatedNumberProps) {
  if (inTest || !Number.isFinite(value)) {
    const text = integerDigits === undefined || !Number.isFinite(value)
      ? plain(value, digits)
      : `${value < 0 ? "-" : ""}${plain(Math.abs(value), digits).padStart(integerDigits + (digits ? digits + 1 : 0), "0")}`;
    return <>{text}</>;
  }
  return <RollingNumber value={value} digits={digits} integerDigits={integerDigits} format={format} />;
}

function RollingNumber({ value, digits, integerDigits, format }: AnimatedNumberProps) {
  // Starts at zero and moves to the real value a frame after it is on screen, so it rolls in.
  const [shown, setShown] = useState(0);
  const lastStep = useRef(0);
  useEffect(() => {
    if (lastStep.current === 0) {
      const frame = requestAnimationFrame(() => { lastStep.current = performance.now(); setShown(value); });
      return () => cancelAnimationFrame(frame);
    }
    const wait = STEP_MS - (performance.now() - lastStep.current);
    if (wait <= 0) {
      lastStep.current = performance.now();
      setShown(value);
      return undefined;
    }
    const timer = window.setTimeout(() => { lastStep.current = performance.now(); setShown(value); }, wait);
    return () => window.clearTimeout(timer);
  }, [value]);
  return (
    <NumberFlow
      value={shown}
      locales="en-GB"
      format={format ?? {
        useGrouping: false,
        minimumIntegerDigits: integerDigits,
        minimumFractionDigits: digits ?? 0,
        maximumFractionDigits: digits ?? 20,
      }}
    />
  );
}

const NUMBER = /\d+(?:\.\d+)?/g;

/**
 * Text whose numbers roll when they change: "12.5 Hz", "3 of 20", "07:20:00". Each run of digits is an
 * [`AnimatedNumber`] with the same decimal places and leading zeros it was written with; everything else, a minus sign
 * included, is left as text. For a string that arrives already formatted, where the number cannot be passed by itself.
 */
export function AnimatedText({ children }: { children: string }) {
  if (!/\d/.test(children)) return <AnimatedWord>{children}</AnimatedWord>;
  const parts: React.ReactNode[] = [];
  let from = 0;
  let place = 0;
  for (const match of children.matchAll(NUMBER)) {
    const [whole, fraction = ""] = match[0].split(".");
    parts.push(children.slice(from, match.index));
    parts.push(
      <AnimatedNumber
        // Keyed by which number it is, not where it sits, so "9 min 59 s" becoming "10 min 0 s" rolls both.
        key={place++}
        value={Number(match[0])}
        digits={fraction.length > 0 ? fraction.length : undefined}
        integerDigits={whole.length > 1 && whole.startsWith("0") ? whole.length : undefined}
      />,
    );
    from = match.index + match[0].length;
  }
  parts.push(children.slice(from));
  return <>{parts}</>;
}

/** Both words sit in the same grid cell while one fades out and the other in, so the line does not jump. */
const STACK: React.CSSProperties = { display: "inline-grid" };
const CELL: React.CSSProperties = { gridArea: "1 / 1", whiteSpace: "nowrap" };

/**
 * A word or short phrase that slides and fades to its new text when it changes, such as "OFFLINE" becoming "ONLINE".
 * Text with digits in it goes through [`AnimatedText`] instead, which rolls only the numbers. A screen reader hears
 * just the current text once; anyone who asked for reduced motion, and every test, gets the plain text.
 */
export function AnimatedWord({ children }: { children: string }) {
  const reduce = useReducedMotion();
  if (inTest || reduce) return <>{children}</>;
  return (
    <span style={STACK}>
      <span className="sr-only">{children}</span>
      <AnimatePresence initial={false}>
        <motion.span
          key={children}
          aria-hidden="true"
          style={CELL}
          initial={{ opacity: 0, y: "0.45em", filter: "blur(2px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: "-0.45em", filter: "blur(2px)" }}
          transition={{ duration: 0.22, ease: "easeOut" }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
