import { useEffect, useState, type ReactNode } from "react";

export type SettingsGroupId = "watch" | "gestures" | "headphones" | "recording" | "appearance";

/** The page's groups, in the order they appear. */
export const SETTINGS_GROUPS: { id: SettingsGroupId; title: string; summary: string }[] = [
  { id: "watch", title: "Watch", summary: "How the watch connects, how it is worn, and which of its sensors stream at what rate." },
  { id: "gestures", title: "Gestures", summary: "Which built-in wrist gestures are recognised, and how strong each has to be." },
  { id: "headphones", title: "Headphones", summary: "Head tracking from the headphones." },
  { id: "recording", title: "Recording & graphs", summary: "What is recorded and how the live graphs are drawn." },
  { id: "appearance", title: "Display", summary: "How the app looks. Applies at once." },
];

const groupElementId = (id: SettingsGroupId) => `settings-group-${id}`;

/** One group of the Settings page: a heading, what it covers, and its sections. */
export function SettingsGroup({ id, children }: { id: SettingsGroupId; children: ReactNode }) {
  const group = SETTINGS_GROUPS.find((entry) => entry.id === id)!;
  const headingId = `${groupElementId(id)}-heading`;
  return (
    <section id={groupElementId(id)} aria-labelledby={headingId} className="settings-group flex flex-col gap-4">
      <div className="settings-group-head">
        <h2 id={headingId}>{group.title}</h2>
        <p className="hint">{group.summary}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * The page's index, kept in view while scrolling: a button per group that scrolls to it, the group in view marked as
 * current. Every group stays on the page, so applying checks every field at once.
 */
export function SettingsNav() {
  const [current, setCurrent] = useState<SettingsGroupId>(SETTINGS_GROUPS[0].id);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0]?.target.id.replace("settings-group-", "") as SettingsGroupId | undefined;
        if (id) setCurrent(id);
      },
      // A group counts as current once its heading is in the upper part of the window.
      { rootMargin: "0px 0px -65% 0px" },
    );
    SETTINGS_GROUPS.forEach(({ id }) => {
      const element = document.getElementById(groupElementId(id));
      if (element) observer.observe(element);
    });
    return () => observer.disconnect();
  }, []);

  const go = (id: SettingsGroupId) => {
    setCurrent(id);
    document.getElementById(groupElementId(id))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <nav aria-label="Settings sections" className="settings-nav">
      {SETTINGS_GROUPS.map(({ id, title }) => (
        <button key={id} type="button" aria-current={current === id ? "true" : undefined} onClick={() => go(id)}>
          {title}
        </button>
      ))}
    </nav>
  );
}
