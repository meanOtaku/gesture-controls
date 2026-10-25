import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../components/ui/sheet";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Every keyboard shortcut, by where it works. */
export function shortcutGroups(mac: boolean): { title: string; keys: [string, string][] }[] {
  const cmd = mac ? "⌘" : "Ctrl+";
  return [
    {
      title: "Anywhere",
      keys: [
        [`${cmd}1 … ${cmd}9`, "Go to a tab, in the order of the menu"],
        [`${cmd},`, "Settings"],
        ["?", "This list"],
      ],
    },
    {
      title: "Labelling: labels",
      keys: [
        ["1 … 9", "Choose a label"],
        ["0", "Choose “Nothing here”"],
        ["L", "Choose “Leave out”"],
        ["Enter", "Label the selection"],
        ["⌫ / Delete", "Erase your label on the selection"],
        [`${cmd}Z`, "Undo"],
        [`${cmd}⇧Z or ${cmd}Y`, "Redo"],
      ],
    },
    {
      title: "Labelling: selecting and moving",
      keys: [
        ["Drag", "Select a stretch (edges snap; hold Alt not to)"],
        ["← / →", "Move the selection's end (Alt: its start, Shift: five times as far)"],
        ["Esc", "Clear the selection"],
        [`${cmd}scroll or pinch`, "Zoom where the cursor is"],
        ["Shift+scroll or a sideways swipe", "Move along"],
        ["← / → on the overview", "Move along by half a view"],
      ],
    },
    {
      title: "Labelling: reviewing",
      keys: [
        ["[ / ]", "Previous / next place to check"],
        ["N / P", "Next / previous suggestion"],
        ["X", "Skip the suggestion"],
      ],
    },
    {
      title: "Recorder",
      keys: [["Hold Space or Enter on Mark label", "Mark the label while held"]],
    },
  ];
}

/** The keyboard shortcuts, opened with `?` from anywhere but a text field. */
export function ShortcutsSheet() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      // Some keyboards report Shift+/ as "/" with Shift held rather than as "?".
      const question = event.key === "?" || (event.key === "/" && event.shiftKey);
      if (question && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setOpen((now) => !now);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Keyboard shortcuts</SheetTitle>
          <SheetDescription>Press ? again, or Esc, to close.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4">
          {shortcutGroups(isMac()).map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="label mb-1">{group.title}</h3>
              <dl className="shortcut-list">
                {group.keys.map(([keys, what]) => (
                  <div key={keys}>
                    <dt><kbd>{keys}</kbd></dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
