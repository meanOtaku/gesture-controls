/**
 * How a session was recorded: which wrist, where the arm was, what you were doing, how the strap sat and how you pinched.
 * The model only learns the conditions it was shown, so this is kept with every recording (`# context.<field>: <value>`
 * lines at the top of its files, and `context` in `recording.json`), where Model Lab and the Labelling page show it.
 */

/** The details, by field. A field left empty is not recorded. */
export type SessionContext = Partial<Record<SessionField, string>>;

export type SessionField = "wrist" | "arm" | "activity" | "strap" | "pinch" | "notes";

export interface SessionFieldSpec {
  field: SessionField;
  title: string;
  /** The values to choose from; none for free text. */
  options?: { value: string; title: string }[];
  placeholder?: string;
}

export const SESSION_FIELDS: SessionFieldSpec[] = [
  { field: "wrist", title: "Watch on", options: [{ value: "left", title: "Left wrist" }, { value: "right", title: "Right wrist" }] },
  {
    field: "arm",
    title: "Arm",
    options: [
      { value: "resting", title: "Resting on a surface" },
      { value: "raised", title: "Raised, held still" },
      { value: "moving", title: "Moving" },
      { value: "walking", title: "Walking" },
    ],
  },
  { field: "activity", title: "Doing", placeholder: "e.g. typing, using the mouse, nothing in particular" },
  { field: "strap", title: "Strap", options: [{ value: "loose", title: "Loose" }, { value: "normal", title: "Normal" }, { value: "tight", title: "Tight" }] },
  { field: "pinch", title: "Pinch", options: [{ value: "light", title: "Light touch" }, { value: "firm", title: "Firm press" }] },
  { field: "notes", title: "Notes", placeholder: "anything else about this session" },
];

const STORAGE_KEY = "recorder.sessionContext";
const MAX_LENGTH = 120;

/** A value as it is stored: one line, trimmed, not too long. */
export function cleanValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_LENGTH);
}

/** Only the fields that have a value, cleaned. */
export function cleanContext(context: SessionContext): SessionContext {
  const out: SessionContext = {};
  for (const { field } of SESSION_FIELDS) {
    const value = cleanValue(context[field] ?? "");
    if (value) out[field] = value;
  }
  return out;
}

/** The `# context.<field>: <value>` lines for a recording's files, in field order. */
export function contextCommentLines(context: SessionContext): string[] {
  const clean = cleanContext(context);
  return SESSION_FIELDS.filter(({ field }) => clean[field]).map(({ field }) => `# context.${field}: ${clean[field]}`);
}

/** The details last used, so the next session starts from them; empty when none were kept or storage is unavailable. */
export function loadSessionContext(): SessionContext {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as SessionContext | null;
    return saved && typeof saved === "object" ? cleanContext(saved) : {};
  } catch {
    return {};
  }
}

export function saveSessionContext(context: SessionContext): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleanContext(context)));
  } catch {
    // Remembering the details is a convenience; the recording still gets them.
  }
}

/** "Left wrist · Resting on a surface · typing": the details in words, for a list. */
export function describeContext(context: Record<string, string> | undefined): string {
  if (!context) return "";
  return SESSION_FIELDS.filter(({ field }) => context[field])
    .map(({ field, options }) => options?.find((option) => option.value === context[field])?.title ?? context[field])
    .join(" · ");
}
