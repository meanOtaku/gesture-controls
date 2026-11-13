import { Activity, Brain, ChevronDown, ChevronRight, CircleDot, Database, Highlighter, Network, FolderOpen, Hand, Headphones, Shapes, Tags, Radar, LayoutDashboard, Plane, Settings as SettingsIcon, SlidersHorizontal, Watch, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
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
import { MissMarker } from "../../features/misses/MissMarker";

export type AppTab = "main" | "headphone" | "watch" | "recipes" | "devices" | "drone" | "gestures" | "signals" | "recorder" | "recordings" | "datasets" | "labelling" | "labels" | "gestureLibrary" | "modelLab" | "networkLab" | "settings";

type NavItem = { id: AppTab; label: string; icon: typeof LayoutDashboard };

const MAIN: NavItem = { id: "main", label: "Overview", icon: LayoutDashboard };

/**
 * The groups. What is used every day comes first: the gestures and recipes, then the devices. The pages for making a model
 * (record, label, train) come after, under one heading that folds away, since they are only needed while a model is made.
 */
const GROUPS: { title: string; items: NavItem[]; lab?: boolean }[] = [
  {
    title: "Use",
    items: [
      { id: "gestures", label: "Gestures", icon: Radar },
      { id: "recipes", label: "Recipes", icon: Workflow },
      { id: "devices", label: "Virtual devices", icon: SlidersHorizontal },
    ],
  },
  {
    title: "Devices",
    items: [{ id: "watch", label: "Watch", icon: Watch }, { id: "headphone", label: "Headphones", icon: Headphones }, { id: "drone", label: "Drone", icon: Plane }],
  },
  {
    title: "Record",
    lab: true,
    items: [
      { id: "signals", label: "Live signals", icon: Activity },
      { id: "recorder", label: "Recorder", icon: CircleDot },
      { id: "recordings", label: "Recordings", icon: FolderOpen },
      { id: "datasets", label: "Datasets", icon: Database },
    ],
  },
  {
    title: "Label",
    lab: true,
    items: [
      { id: "labelling", label: "Labelling", icon: Highlighter },
      { id: "labels", label: "Labels", icon: Tags },
      { id: "gestureLibrary", label: "Gesture library", icon: Shapes },
    ],
  },
  { title: "Train", lab: true, items: [{ id: "modelLab", label: "Model Lab", icon: Brain }, { id: "networkLab", label: "Network lab", icon: Network }] },
];
/** The pages for making a model, which fold away together. */
const LAB_TABS = new Set<AppTab>(GROUPS.filter((group) => group.lab).flatMap((group) => group.items.map((item) => item.id)));
const LAB_OPEN_KEY = "navLabOpen";

/** Whether the model-making pages were left unfolded, remembered between visits. A browser that will not say means unfolded. */
function readLabOpen(): boolean {
  try {
    return window.localStorage.getItem(LAB_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

const SETTINGS: NavItem = { id: "settings", label: "Settings", icon: SettingsIcon };
const ALL: NavItem[] = [MAIN, ...GROUPS.flatMap((group) => group.items), SETTINGS];

/** The name of every page, as the nav shows it. */
export const NAV_LABELS: Record<AppTab, string> = Object.fromEntries(ALL.map((item) => [item.id, item.label])) as Record<AppTab, string>;

/** Display order. Cmd/Ctrl+1..9 select the first nine and Cmd/Ctrl+0 the tenth; Settings is also Cmd/Ctrl+, (the usual place for it). */
export const NAV_ORDER: AppTab[] = ALL.map((item) => item.id);

export type NavTone = "ok" | "warn" | "live" | "idle";
export interface NavStatus { tone: NavTone; label: string }

export interface NavStatusInput {
  headphonesConnected: boolean;
  watchConnected: boolean;
  /** Watch off-body detector: false when taken off, null until it reports. */
  watchWorn: boolean | null;
  recordingState: "idle" | "arming" | "recording" | "saved" | "discarded";
  /** Whether a camera is on (hand tracking for the Recorder's marking). */
  cameraOn?: boolean;
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
    ...(recording
      ? { recorder: { tone: "live", label: "recording" } as NavStatus }
      : input.cameraOn
        ? { recorder: { tone: "ok", label: "camera on" } as NavStatus }
        : {}),
  };
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT_COUNT = 10;
/** The digit that selects the page at `index` in display order: 1 to 9, then 0 for the tenth. */
const digitFor = (index: number): string | null => (index < 0 || index >= SHORTCUT_COUNT ? null : String((index + 1) % 10));
/** The shortcut for a tab, or null when it has none (only the first ten are numbered; Settings has its own). */
export function shortcutFor(tab: AppTab): string | null {
  const key = tab === "settings" ? "," : digitFor(NAV_ORDER.indexOf(tab));
  return key === null ? null : `${isMac() ? "⌘" : "Ctrl+"}${key}`;
}

type AppNavProps = {
  activeTab: AppTab;
  onSelect: (tab: AppTab) => void;
  statuses?: Partial<Record<AppTab, NavStatus>>;
};

/**
 * Primary navigation: what is used every day first, then the devices, then the pages for making a model (which fold away
 * under one heading), with Settings pinned at the bottom.
 */
export function AppNav({ activeTab, onSelect, statuses = {} }: AppNavProps) {
  const [labOpen, setLabOpen] = useState(readLabOpen);
  // The page you are on is never folded away.
  const labShown = labOpen || LAB_TABS.has(activeTab);
  const toggleLab = () =>
    setLabOpen((open) => {
      try {
        window.localStorage.setItem(LAB_OPEN_KEY, String(!open));
      } catch {
        // Remembering is a convenience; the menu still folds without it.
      }
      return !open;
    });

  // Cmd/Ctrl + 1..9 jumps to a tab, and Cmd/Ctrl + , to Settings. A modified key is never text, so it is safe inside a field too.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key === ",") {
        event.preventDefault();
        onSelect("settings");
        return;
      }
      const digit = Number(event.key);
      const index = digit === 0 ? 9 : digit - 1;
      if (/^[0-9]$/.test(event.key) && index < Math.min(SHORTCUT_COUNT, NAV_ORDER.length)) {
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
          tooltip={shortcutFor(id) ? `${label} (${shortcutFor(id)})` : label}
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
        {GROUPS.filter((group) => !group.lab).map((group) => (
          <SidebarGroup key={group.title}>
            <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{group.items.map(entry)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <button type="button" className="nav-lab-toggle" aria-expanded={labShown} aria-controls="nav-lab" disabled={LAB_TABS.has(activeTab)} onClick={toggleLab}>
            {labShown ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
            Make a model
          </button>
        </SidebarGroup>
        <div id="nav-lab" hidden={!labShown}>
          {GROUPS.filter((group) => group.lab).map((group) => (
            <SidebarGroup key={group.title}>
              <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>{group.items.map(entry)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </div>
      </SidebarContent>
      <SidebarFooter>
        <MissMarker />
        <SidebarMenu>{entry(SETTINGS)}</SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
