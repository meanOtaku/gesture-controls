import { useEffect, useRef, useState } from "react";

export const FLASH_MS = 1500;

/**
 * True for a moment each time `count` goes up, so a card can light when its gesture is recognised. The value the page
 * opens with is not a recognition, so it does not flash.
 */
export function useFlash(count: number, ms = FLASH_MS): boolean {
  const [lit, setLit] = useState(false);
  const previous = useRef(count);
  useEffect(() => {
    if (count <= previous.current) {
      previous.current = count;
      return;
    }
    previous.current = count;
    setLit(true);
    const timer = window.setTimeout(() => setLit(false), ms);
    return () => window.clearTimeout(timer);
  }, [count, ms]);
  return lit;
}
