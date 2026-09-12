import { useSyncExternalStore } from "react";
import { dismissFeedback, getFeedbackMessages, subscribeToFeedback } from "./OperationFeedback";

/** App-wide transient feedback: one toast per pending/terminal async action outcome. */
export function OperationToaster() {
  const messages = useSyncExternalStore(subscribeToFeedback, getFeedbackMessages, getFeedbackMessages);
  if (messages.length === 0) return null;

  return (
    <div className="operation-toaster" aria-live="polite">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`operation-toast operation-toast-${message.kind}`}
          role={message.kind === "error" ? "alert" : "status"}
        >
          <strong>{message.operation}</strong>
          <span>{message.detail}</span>
          <button type="button" aria-label={`Dismiss ${message.operation} notification`} onClick={() => dismissFeedback(message.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
