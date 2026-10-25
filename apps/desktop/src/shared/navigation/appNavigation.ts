/**
 * Lets one page send you to another: `open(tab)` switches the app's tab, and the Labelling page takes a request to open a
 * recording at a moment (`openInLabelling`). The app shell listens; a page only asks.
 */
export interface LabellingFocus {
  datasetId: string;
  /** The moment to show, in ms after the recording's first sample. */
  atMs: number;
  /** A stretch to select there, ready to label (ms after the first sample). */
  select?: { startMs: number; endMs: number };
}

type Listener = (tab: string) => void;
const listeners = new Set<Listener>();
let pendingFocus: LabellingFocus | null = null;
const focusListeners = new Set<() => void>();

export const appNavigation = {
  open(tab: string): void {
    listeners.forEach((listener) => listener(tab));
  },
  onOpen(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Opens the Labelling page on a recording at a moment. */
  openInLabelling(focus: LabellingFocus): void {
    pendingFocus = focus;
    focusListeners.forEach((listener) => listener());
    appNavigation.open("labelling");
  },
  /** The waiting request, taken so it is acted on once. */
  takeLabellingFocus(): LabellingFocus | null {
    const focus = pendingFocus;
    pendingFocus = null;
    return focus;
  },
  onLabellingFocus(listener: () => void): () => void {
    focusListeners.add(listener);
    return () => focusListeners.delete(listener);
  },
};
