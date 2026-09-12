import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { SectionHeader } from "../../../components/app/SectionHeader";

type SetupStep = {
  key: string;
  complete: boolean;
  title: string;
  description: string;
  navigateTo?: "headphone" | "watch";
  navigateLabel?: string;
};

type OverviewSectionProps = {
  connected: boolean;
  calibrated: boolean;
  watchConnected: boolean;
  gestureReady: boolean;
  deviceName: string | null;
  onNavigate?: (view: "headphone" | "watch") => void;
};

/** Main-tab device/gesture status cards and the onboarding checklist that guides first-time setup. */
export function OverviewSection({ connected, calibrated, watchConnected, gestureReady, deviceName, onNavigate }: OverviewSectionProps) {
  const steps: SetupStep[] = [
    {
      key: "headphones",
      complete: connected,
      title: "Connect your headphones",
      description: "Start the Sony bridge and connect your headset in Bluetooth settings.",
      navigateTo: "headphone",
      navigateLabel: "Check headphones →",
    },
    {
      key: "calibration",
      complete: connected && calibrated,
      title: "Set your head positions",
      description: "Capture the screen center, then the top-right corner. Hold still for each capture.",
      navigateTo: "headphone",
      navigateLabel: "Open calibration →",
    },
    {
      key: "watch",
      complete: watchConnected,
      title: "Connect your Galaxy Watch",
      description: "Open the Watch app with both devices on the same Wi-Fi network.",
      navigateTo: "watch",
      navigateLabel: "Check Watch →",
    },
  ];
  const completedCount = steps.filter((step) => step.complete).length;

  return (
    <>
      <section className="overview-grid" aria-label="Device overview">
        <Card><CardContent><span className="label">Headphones</span><strong>{connected ? "Connected" : "Waiting"}</strong><small>{deviceName ?? "Sony bridge not detected"}</small></CardContent></Card>
        <Card><CardContent><span className="label">Galaxy Watch</span><strong>{watchConnected ? "Connected" : "Waiting"}</strong><small>{watchConnected ? "Streaming to this desktop" : "Searching for desktop"}</small></CardContent></Card>
        <Card>
          <CardContent>
            <span className="label">Volume gesture</span>
            <strong>{gestureReady ? "Ready" : "Set up"}</strong>
            <small>{!connected ? "Connect headphones to begin" : !calibrated ? "Capture your two head positions" : !watchConnected ? "Connect Watch for wrist control" : "Look top-right to open the knob"}</small>
          </CardContent>
        </Card>
      </section>

      <Card role="region" aria-label="Setup checklist">
        <CardHeader>
          <SectionHeader
            title={gestureReady ? "You’re ready to take control" : "Get your devices ready"}
            description="Your next steps"
            status={<Badge variant={gestureReady ? "default" : "secondary"}>{completedCount} / {steps.length} complete</Badge>}
          />
        </CardHeader>
        <CardContent>
          <ol className="setup-steps">
            {steps.map((step, index) => (
              <li key={step.key} data-complete={step.complete}>
                <span className="step-number">{step.complete ? "✓" : String(index + 1)}</span>
                <div><strong>{step.title}</strong><p>{step.description}</p></div>
                {onNavigate && step.navigateTo && (
                  <Button type="button" variant="outline" onClick={() => onNavigate(step.navigateTo!)}>
                    {step.navigateLabel}
                  </Button>
                )}
              </li>
            ))}
          </ol>
          <p className="interaction-guide">Look top-right to show the knob. Hold the Watch button, rotate your wrist, then release. Press Escape to hide the knob.</p>
        </CardContent>
      </Card>
    </>
  );
}
