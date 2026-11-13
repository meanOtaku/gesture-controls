import { AnimatedNumber, AnimatedWord } from "../../../components/app/AnimatedNumber";
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
  // The watch comes first: shakes, taps and the other wrist gestures need nothing else. The headphones add head
  // locations, for recipes that start by looking somewhere.
  const steps: SetupStep[] = [
    {
      key: "watch",
      complete: watchConnected,
      title: "Connect your Galaxy Watch",
      description: "Open the Watch app and enable streaming. It connects over Bluetooth by default; Wi-Fi is under Settings → Watch.",
      navigateTo: "watch",
      navigateLabel: "Check Watch →",
    },
    {
      key: "headphones",
      complete: connected,
      title: "Connect your headphones (optional)",
      description: "Only for recipes that start by looking somewhere. Connect your headset in Bluetooth settings.",
      navigateTo: "headphone",
      navigateLabel: "Check headphones →",
    },
    {
      key: "calibration",
      complete: connected && calibrated,
      title: "Set your head positions (optional)",
      description: "Capture the screen center, then the top-right corner. Hold still for each capture.",
      navigateTo: "headphone",
      navigateLabel: "Open calibration →",
    },
  ];
  const completedCount = steps.filter((step) => step.complete).length;

  return (
    <>
      <section className="overview-grid" aria-label="Device overview">
        <Card><CardContent><span className="label">Headphones</span><strong><AnimatedWord>{connected ? "Connected" : "Waiting"}</AnimatedWord></strong><small><AnimatedWord>{deviceName ?? "Sony bridge not detected"}</AnimatedWord></small></CardContent></Card>
        <Card><CardContent><span className="label">Galaxy Watch</span><strong><AnimatedWord>{watchConnected ? "Connected" : "Waiting"}</AnimatedWord></strong><small><AnimatedWord>{watchConnected ? "Streaming to this desktop" : "Searching for desktop"}</AnimatedWord></small></CardContent></Card>
        <Card>
          <CardContent>
            <span className="label">Volume gesture</span>
            <strong><AnimatedWord>{gestureReady ? "Ready" : watchConnected ? "Watch only" : "Set up"}</AnimatedWord></strong>
            <small>{!watchConnected ? "Connect the Watch to begin" : !connected ? "Wrist gestures work now; headphones add head locations" : !calibrated ? "Capture your two head positions" : "Look top-right to open the knob"}</small>
          </CardContent>
        </Card>
      </section>

      <Card role="region" aria-label="Setup checklist">
        <CardHeader>
          <SectionHeader
            title={gestureReady ? "You’re ready to take control" : watchConnected ? "The watch is ready" : "Get your devices ready"}
            description="Your next steps"
            status={<Badge variant={gestureReady ? "default" : "secondary"}><AnimatedNumber value={completedCount} /> / {<AnimatedNumber value={steps.length} />} complete</Badge>}
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
          <p className="interaction-guide">
            {connected
              ? "Look top-right to show the knob. Hold the Watch button, rotate your wrist, then release. Press Escape to hide the knob."
              : "With the watch alone: make a recipe from a shake, a tap or a hammer on your palm under Recipes, and try each gesture under Gestures. A double tap can switch a volume dial on and off."}
          </p>
        </CardContent>
      </Card>
    </>
  );
}
