export type FeedbackKind = "success" | "info" | "warning" | "error";

export type FeedbackMessage = {
  id: number;
  kind: FeedbackKind;
  /** Short operation name, e.g. "Export dataset CSV". */
  operation: string;
  /** Human-readable outcome, e.g. "Saved to gesture-dataset.csv" or a non-secret error detail. */
  detail: string;
};

type Listener = (messages: FeedbackMessage[]) => void;

const DEFAULT_DURATION_MS: Record<FeedbackKind, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 8000,
};

let nextId = 1;
let messages: FeedbackMessage[] = [];
const listeners = new Set<Listener>();

function publish(): void {
  for (const listener of listeners) listener(messages);
}

export function subscribeToFeedback(listener: Listener): () => void {
  listeners.add(listener);
  listener(messages);
  return () => listeners.delete(listener);
}

export function getFeedbackMessages(): FeedbackMessage[] {
  return messages;
}

export function dismissFeedback(id: number): void {
  messages = messages.filter((message) => message.id !== id);
  publish();
}

export function notifyFeedback(kind: FeedbackKind, operation: string, detail: string): number {
  const id = nextId++;
  messages = [...messages, { id, kind, operation, detail }];
  publish();
  if (typeof window !== "undefined") {
    window.setTimeout(() => dismissFeedback(id), DEFAULT_DURATION_MS[kind]);
  }
  return id;
}

export const OperationFeedback = {
  success: (operation: string, detail: string) => notifyFeedback("success", operation, detail),
  info: (operation: string, detail: string) => notifyFeedback("info", operation, detail),
  warning: (operation: string, detail: string) => notifyFeedback("warning", operation, detail),
  error: (operation: string, detail: string) => notifyFeedback("error", operation, detail),
};

export function resetFeedbackForTests(): void {
  messages = [];
  publish();
}
