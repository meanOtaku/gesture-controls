import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { assessHealth, type HealthItem } from "../quality/signalHealth";
import { telemetryStore } from "../store/telemetryStore";

/** Re-read twice a second: the stream's state changes when samples stop, which publishes nothing. */
const REFRESH_MS = 500;

/**
 * The watch's streams, live: motion and pulse rates and the pulse sensor's contact. While recording, anything wrong is
 * said plainly above everything else, so a broken session is stopped in seconds rather than found afterwards.
 */
export function SignalHealthStrip({ recording }: { recording: boolean }) {
  const [items, setItems] = useState<HealthItem[]>(() => assessHealth(telemetryStore.getSignalHealth()));
  useEffect(() => {
    const timer = setInterval(() => setItems(assessHealth(telemetryStore.getSignalHealth())), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const bad = items.filter((item) => item.level === "bad");
  return (
    <>
      {recording && bad.length > 0 && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Something is wrong with the recording</AlertTitle>
          <AlertDescription>
            {bad.map((item) => `${item.title}: ${item.text}`).join(". ")}. Stop and fix it, or discard this one: a model learns nothing from it.
          </AlertDescription>
        </Alert>
      )}
      <div className="signal-health" role="status" aria-label="Signal health">
        {items.map((item) => (
          <span key={item.key} className={`signal-health-${item.level}`}>
            <i aria-hidden="true" />
            <strong>{item.title}</strong> {item.text}
          </span>
        ))}
      </div>
    </>
  );
}
