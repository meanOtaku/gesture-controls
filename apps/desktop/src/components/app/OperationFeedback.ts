import { toast } from "sonner";

export type FeedbackKind = "success" | "info" | "warning" | "error";

const DURATION_MS: Record<FeedbackKind, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 8000,
};

function notifyFeedback(kind: FeedbackKind, operation: string, detail: string): void {
  toast[kind](operation, { description: detail, duration: DURATION_MS[kind] });
}

/** Standardized typed messages for async operation outcomes, rendered via the app-wide sonner Toaster. */
export const OperationFeedback = {
  success: (operation: string, detail: string) => notifyFeedback("success", operation, detail),
  info: (operation: string, detail: string) => notifyFeedback("info", operation, detail),
  warning: (operation: string, detail: string) => notifyFeedback("warning", operation, detail),
  error: (operation: string, detail: string) => notifyFeedback("error", operation, detail),
};

/** How long an undoable action can be taken back. */
export const UNDO_MS = 8000;

/** A done (or about to be done) action, with Undo on its message. */
export function feedbackWithUndo(operation: string, detail: string, onUndo: () => void): void {
  toast.success(operation, { description: detail, duration: UNDO_MS, action: { label: "Undo", onClick: onUndo } });
}

/**
 * Does `run` after `UNDO_MS`, unless Undo on its message is pressed first, which calls `onUndo` instead. For what cannot be
 * taken back once done, such as deleting: it waits, so it can still be stopped.
 */
export function afterUndoWindow(operation: string, detail: string, run: () => void, onUndo: () => void): void {
  const timer = setTimeout(run, UNDO_MS);
  feedbackWithUndo(operation, detail, () => {
    clearTimeout(timer);
    onUndo();
  });
}

export function resetFeedbackForTests(): void {
  toast.dismiss();
}
