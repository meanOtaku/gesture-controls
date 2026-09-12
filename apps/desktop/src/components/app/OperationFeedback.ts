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

export function resetFeedbackForTests(): void {
  toast.dismiss();
}
