import { Button } from "../../components/ui/button";

export type AppTab = "main" | "headphone" | "watch" | "telemetry" | "modelLab" | "settings";

const TABS: Array<{ id: AppTab; label: string }> = [
  { id: "main", label: "Main" },
  { id: "headphone", label: "Headphones" },
  { id: "watch", label: "Watch" },
  { id: "telemetry", label: "Live data" },
  { id: "modelLab", label: "Model Lab" },
  { id: "settings", label: "Settings" },
];

type AppNavProps = {
  activeTab: AppTab;
  onSelect: (tab: AppTab) => void;
};

/** Primary tab navigation, built from the official shadcn Button. */
export function AppNav({ activeTab, onSelect }: AppNavProps) {
  return (
    <nav className="app-tabs" aria-label="Application views">
      {TABS.map(({ id, label }) => (
        <Button
          key={id}
          type="button"
          variant={activeTab === id ? "default" : "outline"}
          size="sm"
          aria-current={activeTab === id ? "page" : undefined}
          onClick={() => onSelect(id)}
        >
          {label}
        </Button>
      ))}
    </nav>
  );
}
