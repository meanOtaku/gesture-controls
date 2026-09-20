import { Activity, Brain, Headphones, LayoutDashboard, Settings as SettingsIcon, Watch } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "../../components/ui/sidebar";

export type AppTab = "main" | "headphone" | "watch" | "telemetry" | "modelLab" | "settings";

const TABS: Array<{ id: AppTab; label: string; icon: typeof LayoutDashboard }> = [
  { id: "main", label: "Main", icon: LayoutDashboard },
  { id: "headphone", label: "Headphones", icon: Headphones },
  { id: "watch", label: "Watch", icon: Watch },
  { id: "telemetry", label: "Live data", icon: Activity },
  { id: "modelLab", label: "Model Lab", icon: Brain },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

type AppNavProps = {
  activeTab: AppTab;
  onSelect: (tab: AppTab) => void;
};

/** Primary tab navigation, built from the official shadcn Sidebar. */
export function AppNav({ activeTab, onSelect }: AppNavProps) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <span className="px-2 text-sm font-semibold">Spatial Gesture</span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {TABS.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    type="button"
                    isActive={activeTab === id}
                    aria-current={activeTab === id ? "page" : undefined}
                    tooltip={label}
                    onClick={() => onSelect(id)}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
