import { Activity, Brain, Hand, Headphones, LayoutDashboard, Settings as SettingsIcon, SlidersHorizontal, Watch, Workflow } from "lucide-react";
import { useEffect } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "../../components/ui/sidebar";

export type AppTab = "main" | "headphone" | "watch" | "recipes" | "devices" | "telemetry" | "modelLab" | "settings";

type NavItem = { id: AppTab; label: string; icon: typeof LayoutDashboard };

const MAIN: NavItem = { id: "main", label: "Main", icon: LayoutDashboard };
const DEVICES: NavItem[] = [
  { id: "headphone", label: "Headphones", icon: Headphones },
  { id: "watch", label: "Watch", icon: Watch },
];
const AUTOMATION: NavItem[] = [
  { id: "recipes", label: "Recipes", icon: Workflow },
  { id: "devices", label: "Virtual devices", icon: SlidersHorizontal },
];
const DATA: NavItem[] = [
  { id: "telemetry", label: "Live data", icon: Activity },
  { id: "modelLab", label: "Model Lab", icon: Brain },
];
const SETTINGS: NavItem = { id: "settings", label: "Settings", icon: SettingsIcon };

/** Display order, which is also what Cmd/Ctrl+1..6 select. */
export const NAV_ORDER: AppTab[] = [MAIN, ...DEVICES, ...AUTOMATION, ...DATA, SETTINGS].map((item) => item.id);

export type NavTone = "ok" | "warn" | "live" | "idle";
export interface NavStatus { tone: NavTone; label: string }

export interface NavStatusInput {
  headphonesConnected: boolean;
  watchConnected: boolean;
  /** Watch off-body detector: false when taken off, null until it reports. */
  watchWorn: boolean | null;
  recordingState: "idle" | "arming" | "recording" | "saved" | "discarded";
}

/** What each tab's marker says, from the app's live state. Tabs with nothing to report are absent. */
export function navStatuses(input: NavStatusInput): Partial<Record<AppTab, NavStatus>> {
  const watch: NavStatus = !input.watchConnected
    ? { tone: "idle", label: "not connected" }
    : input.watchWorn === false
      ? { tone: "warn", label: "connected, off wrist" }
      : { tone: "ok", label: "connected" };
  const recording = input.recordingState === "recording" || input.recordingState === "arming";
  return {
    headphone: input.headphonesConnected ? { tone: "ok", label: "connected" } : { tone: "idle", label: "not connected" },
    watch,
    ...(recording ? { telemetry: { tone: "live", label: "recording" } as NavStatus } : {}),
  };
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const shortcutHint = (index: number) => `${isMac() ? "⌘" : "Ctrl+"}${index + 1}`;

type AppNavProps = {
  activeTab: AppTab;
  onSelect: (tab: AppTab) => void;
  statuses?: Partial<Record<AppTab, NavStatus>>;
};

/** Primary navigation: Main, then Devices, Automation and Data, with Settings pinned at the bottom. */
export function AppNav({ activeTab, onSelect, statuses = {} }: AppNavProps) {
  // Cmd/Ctrl + 1..8 jumps to a tab. A modified digit is never text, so it is safe inside a field too.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < NAV_ORDER.length) {
        event.preventDefault();
        onSelect(NAV_ORDER[index]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSelect]);

  const entry = ({ id, label, icon: Icon }: NavItem) => {
    const status = statuses[id];
    return (
      <SidebarMenuItem key={id}>
        <SidebarMenuButton
          type="button"
          isActive={activeTab === id}
          aria-current={activeTab === id ? "page" : undefined}
          aria-describedby={status ? `nav-status-${id}` : undefined}
          tooltip={`${label} (${shortcutHint(NAV_ORDER.indexOf(id))})`}
          onClick={() => onSelect(id)}
        >
          <Icon />
          <span>{label}</span>
          {status && <span className="nav-dot" data-tone={status.tone} aria-hidden="true" />}
        </SidebarMenuButton>
        {/* Outside the button so it describes it instead of becoming part of its name. */}
        {status && <span className="sr-only" id={`nav-status-${id}`}>{status.label}</span>}
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="nav-brand" aria-label="Spatial Gesture Control">
          <Hand className="size-6 shrink-0" aria-hidden="true" />
          <span className="nav-brand-name group-data-[collapsible=icon]:hidden" aria-hidden="true">
            Spatial Gesture
            <small>Control</small>
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>{entry(MAIN)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Devices</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{DEVICES.map(entry)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Automation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{AUTOMATION.map(entry)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Data</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{DATA.map(entry)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>{entry(SETTINGS)}</SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
