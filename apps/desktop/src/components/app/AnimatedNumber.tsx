import NumberFlow, { type Format } from "@number-flow/react";
import { useRef } from "react";

/** A number changing again within this long of its last change is changing too fast to roll: it would never settle. */
const FAST_MS = 400;
/** After a fast change, how long the number is shown plainly before it may roll again. */
const CALM_MS = 2000;

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
 * A number that rolls to its new value when it changes (NumberFlow). It reads to a screen reader as the plain number and
 * stands still for anyone who asked for reduced motion.
 *
 * Three cases are shown as plain text instead: a value that is not a finite number (so "NaN" stays "NaN"); a value that
 * changes several times a second, like a live sensor reading, whose digits would never stop rolling; and every value
 * under test, so a sentence with a number in it can still be found whole.
 */
export function AnimatedNumber({ value, digits, integerDigits, format }: AnimatedNumberProps) {
  const last = useRef({ value, at: 0, fastUntil: 0 });
  const now = typeof performance === "undefined" ? 0 : performance.now();
  if (last.current.value !== value) {
    if (last.current.at > 0 && now - last.current.at < FAST_MS) last.current.fastUntil = now + CALM_MS;
    last.current.value = value;
    last.current.at = now;
  }
  const text = integerDigits === undefined || !Number.isFinite(value)
    ? plain(value, digits)
    : `${value < 0 ? "-" : ""}${plain(Math.abs(value), digits).padStart(integerDigits + (digits ? digits + 1 : 0), "0")}`;
  if (inTest || !Number.isFinite(value) || now < last.current.fastUntil) return <>{text}</>;
  return (
    <NumberFlow
      value={value}
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
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (const match of children.matchAll(NUMBER)) {
    const [whole, fraction = ""] = match[0].split(".");
    parts.push(children.slice(from, match.index));
    parts.push(
      <AnimatedNumber
        key={match.index}
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
