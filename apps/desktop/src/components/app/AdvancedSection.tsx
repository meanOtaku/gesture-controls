import { ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

/** Whether a section was left open, remembered per section; a browser that will not say means closed. */
function readOpen(key: string): boolean {
  try {
    return window.localStorage.getItem(`advanced.${key}`) === "open";
  } catch {
    return false;
  }
}

/**
 * Tools a page offers but most visits do not need, folded away under one heading so the page shows its main flow first.
 * Closed by default; whether it was left open is remembered per page (`storageKey`).
 */
export function AdvancedSection({ storageKey, title = "Advanced", summary, id, children }: {
  storageKey: string;
  /** For in-page links to the section. */
  id?: string;
  title?: string;
  /** What is inside, in a few words, shown beside the heading. */
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readOpen(storageKey));
  return (
    <details
      id={id}
      className="advanced-section"
      open={open}
      onToggle={(event) => {
        const now = (event.currentTarget as HTMLDetailsElement).open;
        setOpen(now);
        try {
          window.localStorage.setItem(`advanced.${storageKey}`, now ? "open" : "closed");
        } catch {
          // Remembering is a convenience.
        }
      }}
    >
      <summary>
        <ChevronRightIcon className="advanced-chevron size-4" aria-hidden="true" />
        <span className="advanced-title">{title}</span>
        <span className="advanced-summary">{summary}</span>
      </summary>
      {open && <div className="card-stack advanced-body">{children}</div>}
    </details>
  );
}
