import { AsyncActionButton } from "../../../components/app/AsyncActionButton";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { EnvironmentDiagnostic } from "../types";

type ReadinessPanelProps = {
  desktopAvailable: boolean;
  diagnostics: EnvironmentDiagnostic[];
  error: string | null;
  onRecheck: () => Promise<void>;
};

/** First-run local requirement checks: uv/training runner availability, LiteRT support, volume backend. */
export function ReadinessPanel({ desktopAvailable, diagnostics, error, onRecheck }: ReadinessPanelProps) {
  return (
    <Card role="region" aria-label="Desktop readiness" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Desktop readiness"
          description="Checks run locally and never send data. Training and replay use the development-only uv runner; LiteRT is only available when this desktop build includes it."
          help={{
            label: "About desktop readiness checks",
            content: "These checks confirm the local development runner and LiteRT support are available before you import data or train a model. Nothing is sent off this device.",
          }}
          status={
            <AsyncActionButton disabled={!desktopAvailable} onPress={onRecheck} pendingLabel="Rechecking…">
              Recheck
            </AsyncActionButton>
          }
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {diagnostics.length === 0 && !error ? (
          <p className="hint">
            {desktopAvailable ? "Checking local desktop requirements…" : "Open the desktop app to check training and inference requirements."}
          </p>
        ) : (
          <div className="vectors model-lab-models" aria-label="Desktop readiness checks">
            {diagnostics.map((diagnostic) => (
              <div className="vector-row model-lab-diagnostic-row" key={diagnostic.id}>
                <div>
                  <strong>{diagnostic.title}</strong>
                  <p className="hint">{diagnostic.detail}</p>
                  {diagnostic.action && <p className="model-lab-diagnostic-action">{diagnostic.action}</p>}
                </div>
                <Badge variant={diagnostic.status === "ready" ? "default" : "destructive"}>{diagnostic.status}</Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
