import { invoke } from "@tauri-apps/api/core";
import { feedbackWithUndo, OperationFeedback } from "../../components/app/OperationFeedback";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Label } from "../../components/ui/label";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { SectionHeader } from "../../components/app/SectionHeader";
import { chooseExportFolder } from "../../shared/tauri/exportCsv";
import { getRecordingCameraEvidence, notifyRecordingsChanged } from "../../shared/tauri/recordingBundle";
import type { GestureDefinition } from "../gestureLibrary/definition";
import { listGestureDefinitions } from "../gestureLibrary/gestureLibraryApi";
import { cameraTrack, contactOnsets, contactThreshold, handsAt, type CameraTrack } from "./cameraTrack";
import { inImportOrder, type DatasetLabel, type DatasetSummary } from "../model-lab/types";
import { describeContext } from "../telemetry/sessionContext";
import { exportLabellingRecording, openLabellingRecording, replayActiveModels, saveLabellingVersion, type LabellingRecording, type LabellingSource, type ModelReplay } from "./labellingApi";
import { appNavigation, type LabellingFocus } from "../../shared/navigation/appNavigation";
import { labelColor } from "../labels/labelColor";
import { HandPreview } from "./HandPreview";
import { hazardsIn } from "./hazards";
import { ReviewStatus } from "./ReviewStatus";
import { nextProblem, problemsIn, type Problem } from "./problems";
import { OverviewStrip, type OverviewMark } from "./OverviewStrip";
import { contactSpans, motionBursts, suggestionKey, suggestionsFor } from "./suggestions";
import { LEFT_OUT, snapTo, caughtStarts, commit, formatSeconds, historyOf, lagFromContacts, lagFromDetections, negativeSpanFor, NO_LABEL, paint, pan, redo, sameSpans, shiftRecordedLabels, undo, zoom, type History, type Span } from "./labellingModel";
import { SignalLane, type View } from "./SignalLane";

const COLUMN_TITLES: Record<string, string> = {
  ppg_green: "PPG green", ppg_red: "PPG red", ppg_ir: "PPG infrared", contact_quality: "Contact quality",
  accel_x: "Acceleration x", accel_y: "Acceleration y", accel_z: "Acceleration z",
  gyro_x: "Rotation x", gyro_y: "Rotation y", gyro_z: "Rotation z",
  quat_w: "Orientation w", quat_x: "Orientation x", quat_y: "Orientation y", quat_z: "Orientation z",
};
/** Shown only when ticked: rarely what a gesture shows in. */
const HIDDEN_AT_FIRST = ["contact_quality", "quat_w", "quat_x", "quat_y", "quat_z"];
/** How tall each graph is, by the choice above them. */
const LANE_HEIGHTS = { compact: 100, normal: 160, tall: 240 } as const;
type LaneSize = keyof typeof LANE_HEIGHTS;
/** How far an arrow key moves an edge of the selection; with Shift, five times as far. */
const NUDGE_MS = 20;

type ExportFormat = "folder" | "csv";

/** The work on the page, kept while you visit other pages (the page itself is unmounted). */
interface Kept {
  recording: LabellingRecording;
  history: History;
  /** The hand labels as last saved or opened, to tell whether there is anything unsaved. */
  saved: Span[];
  view: View;
  hidden: string[];
  laneSize: LaneSize;
  fitToView: boolean;
}
let kept: Kept | null = null;

/** How much of the recording is shown around a moment another page asked for. */
const FOCUS_SPAN_MS = 8000;
/** A selection's edge snaps to something this close (pixels). */
const SNAP_PX = 8;

/** Drops the kept work (for tests: each starts with nothing open). */
export function forgetLabellingWork(): void {
  kept = null;
}


/**
 * Label a recording by hand. Open a Model Lab recording, a dataset folder or a CSV; every column is drawn on one shared
 * timeline; drag across any graph to select a stretch, choose a label and apply it (or "Nothing here", or erase). The
 * labels go in the recording's `manual_label` column, which training uses wherever it is set. Save makes a new version in
 * Model Lab and leaves the original as it was; Export writes the folder of two files (or one CSV).
 */
export function LabellingPage() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [catalogue, setCatalogue] = useState<DatasetLabel[]>([]);
  const [recording, setRecording] = useState<LabellingRecording | null>(kept?.recording ?? null);
  const [history, setHistory] = useState<History>(kept?.history ?? historyOf([]));
  const [saved, setSaved] = useState<Span[]>(kept?.saved ?? []);
  const [view, setView] = useState<View>(kept?.view ?? { startMs: 0, endMs: 1 });
  const [hidden, setHidden] = useState<string[]>(kept?.hidden ?? HIDDEN_AT_FIRST);
  const [laneSize, setLaneSize] = useState<LaneSize>(kept?.laneSize ?? "normal");
  const [fitToView, setFitToView] = useState<boolean>(kept?.fitToView ?? false);
  const [snap, setSnap] = useState(true);
  const [selection, setSelection] = useState<View | null>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const [chosen, setChosen] = useState<string>(NO_LABEL);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("folder");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pendingSource, setPendingSource] = useState<{ source: LabellingSource; focus?: Omit<LabellingFocus, "datasetId"> } | null>(null);
  const [replays, setReplays] = useState<ModelReplay[] | null>(null);
  const [camera, setCamera] = useState<{ track: CameraTrack } | { problem: string } | null>(null);
  const [definitions, setDefinitions] = useState<GestureDefinition[]>([]);
  const [replaying, setReplaying] = useState(false);
  const [width, setWidth] = useState(0);
  const area = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<number | null>(null);

  const spans = history.present;
  const dirty = recording !== null && !sameSpans(spans, saved);
  const durationMs = Math.max(1, recording?.durationMs ?? 1);

  useEffect(() => {
    kept = recording ? { recording, history, saved, view, hidden, laneSize, fitToView } : null;
  }, [recording, history, saved, view, hidden, laneSize, fitToView]);

  const refreshLists = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      const [sets, labels] = await Promise.all([
        invoke<DatasetSummary[]>("list_model_datasets"),
        invoke<DatasetLabel[]>("list_model_labels"),
      ]);
      setDatasets(inImportOrder(Array.isArray(sets) ? sets : []));
      setCatalogue((Array.isArray(labels) ? labels : []).filter((label) => !label.archivedAt));
      const gestures = await listGestureDefinitions().catch(() => []);
      setDefinitions(Array.isArray(gestures) ? gestures : []);
    } catch (error) {
      setMessage({ tone: "error", text: String(error) });
    }
  }, [desktopAvailable]);
  useEffect(() => void refreshLists(), [refreshLists]);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [recording !== null]);

  const colorOf = useCallback((label: string) => labelColor(label, catalogue), [catalogue]);
  const nameOf = useCallback(
    (label: string) => (label === NO_LABEL ? "Nothing here" : label === LEFT_OUT ? "Left out" : catalogue.find((entry) => entry.id === label)?.displayName || label),
    [catalogue],
  );

  const load = useCallback(async (source: LabellingSource, focus?: Omit<LabellingFocus, "datasetId">) => {
    setBusy(true);
    setMessage(null);
    try {
      const opened = await openLabellingRecording(source);
      setRecording(opened);
      setHistory(historyOf(opened.manualIntervals));
      setSaved(opened.manualIntervals);
      const whole = { startMs: 0, endMs: Math.max(1, opened.durationMs) };
      // A moment asked for is shown with a few seconds either side.
      setView(focus ? pan({ startMs: focus.atMs - FOCUS_SPAN_MS / 2, endMs: focus.atMs + FOCUS_SPAN_MS / 2 }, 0, whole.endMs) : whole);
      setSelection(focus?.select ?? null);
      setReplays(null);
    } catch (error) {
      setMessage({ tone: "error", text: `Could not open it: ${String(error)}` });
    } finally {
      setBusy(false);
    }
  }, []);

  const request = (source: LabellingSource, focus?: Omit<LabellingFocus, "datasetId">) =>
    dirty ? setPendingSource({ source, focus }) : void load(source, focus);

  // Sent here from another page (a model's mistakes) to look at a moment of a recording.
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    const take = () => {
      const focus = appNavigation.takeLabellingFocus();
      if (focus) requestRef.current({ kind: "dataset", id: focus.datasetId }, focus);
    };
    take();
    return appNavigation.onLabellingFocus(take);
  }, []);

  const chooseFile = async (directory: boolean) => {
    const picked = await open(
      directory
        ? { directory: true, multiple: false, title: "Choose a recording folder (it holds ppg.csv and imu.csv)" }
        : { multiple: false, title: "Choose a dataset CSV", filters: [{ name: "CSV", extensions: ["csv"] }] },
    );
    if (typeof picked === "string") request({ kind: "file", path: picked });
  };

  const applyLabel = useCallback(
    (label: string | null) => {
      if (!selection) return;
      setHistory((current) => commit(current, paint(current.present, selection.startMs, selection.endMs, label)));
    },
    [selection],
  );

  const labelKeys = useMemo(() => catalogue.slice(0, 9).map((label) => label.id), [catalogue]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setHistory((current) => (event.shiftKey ? redo(current) : undo(current)));
      } else if (command && event.key.toLowerCase() === "y") {
        event.preventDefault();
        setHistory(redo);
      } else if (!command && /^[1-9]$/.test(event.key) && labelKeys[Number(event.key) - 1]) {
        setChosen(labelKeys[Number(event.key) - 1]);
      } else if (!command && event.key === "0") {
        setChosen(NO_LABEL);
      } else if (!command && event.key.toLowerCase() === "l") {
        setChosen(LEFT_OUT);
      } else if (event.key === "Enter" && selection) {
        event.preventDefault();
        applyLabel(chosen);
      } else if ((event.key === "Backspace" || event.key === "Delete") && selection) {
        event.preventDefault();
        applyLabel(null);
      } else if (event.key === "Escape") {
        setSelection(null);
      } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && selection) {
        event.preventDefault();
        const step = (event.key === "ArrowLeft" ? -1 : 1) * NUDGE_MS * (event.shiftKey ? 5 : 1);
        const clamp = (ms: number) => Math.min(durationMs, Math.max(0, ms));
        setSelection((current) => current && (event.altKey ? { ...current, startMs: clamp(current.startMs + step) } : { ...current, endMs: clamp(current.endMs + step) }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, selection, chosen, labelKeys, applyLabel, durationMs]);

  const msAt = (clientX: number) => {
    const box = area.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0;
    return view.startMs + ((clientX - box.left) / box.width) * (view.endMs - view.startMs);
  };
  // A selection's edges snap to where something happened (Alt held: they do not): within a few pixels of it.
  const snapPoints = useRef<number[]>([]);
  const snapped = (at: number, free: boolean) => {
    const shownWidth = area.current?.getBoundingClientRect().width ?? 0;
    if (!snap || free || shownWidth <= 0) return at;
    return snapTo(at, snapPoints.current, (SNAP_PX / shownWidth) * (view.endMs - view.startMs));
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const at = snapped(msAt(event.clientX), event.altKey);
    dragFrom.current = at;
    setSelection({ startMs: at, endMs: at });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const raw = msAt(event.clientX);
    setHoverMs(raw);
    if (dragFrom.current === null) return;
    const at = snapped(raw, event.altKey);
    setSelection({ startMs: Math.min(dragFrom.current, at), endMs: Math.max(dragFrom.current, at) });
  };
  const onPointerUp = () => {
    dragFrom.current = null;
    setSelection((current) => (current && current.endMs - current.startMs < 1 ? null : current));
  };
  // Up and down scrolling scrolls the page as anywhere else (see below). Ctrl/⌘+scroll (and a trackpad pinch, which arrives as one)
  // zooms where the cursor is, and a sideways swipe or Shift+scroll moves along; those must not scroll the page too, and
  // React's wheel handlers cannot stop it, so this one is attached directly.
  const wheelState = useRef({ width, durationMs });
  wheelState.current = { width, durationMs };
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const zooming = event.ctrlKey || event.metaKey;
      // A trackpad's up-and-down scroll drifts sideways a little: only a clearly sideways swipe moves along.
      const sideways = Math.abs(event.deltaX) > 2 * Math.abs(event.deltaY) && Math.abs(event.deltaX) >= 4;
      const panning = !zooming && (sideways || event.shiftKey);
      event.preventDefault();
      if (!zooming && !panning) {
        // Up and down: scroll the page. Done here rather than left to the browser, because the desktop app's web view does
        // not scroll the page from an element with its own wheel handler.
        scrollParentOf(element).scrollBy({ top: pixels(event, event.deltaY, element) });
        return;
      }
      const { width: shownWidth, durationMs: total } = wheelState.current;
      const box = element.getBoundingClientRect();
      if (panning) {
        setView((current) => pan(current, ((event.deltaX || event.deltaY) / Math.max(1, shownWidth)) * (current.endMs - current.startMs), total));
      } else {
        setView((current) => {
          const at = current.startMs + ((event.clientX - box.left) / Math.max(1, box.width)) * (current.endMs - current.startMs);
          return zoom(current, at, event.deltaY > 0 ? 1.25 : 0.8, total);
        });
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [recording !== null]);

  const saveVersion = async () => {
    if (!recording) return;
    setBusy(true);
    try {
      const summary = await saveLabellingVersion(recording.source, spans);
      notifyRecordingsChanged();
      await refreshLists();
      // The new version is what you go on labelling; the original stays as it was.
      await load({ kind: "dataset", id: summary.id });
      OperationFeedback.success("Saved", `A new recording in Model Lab: #${summary.sequence ?? "?"} ${summary.originalFilename}. The original is unchanged.`);
    } catch (error) {
      setMessage({ tone: "error", text: `Not saved: ${String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const exportIt = async () => {
    if (!recording) return;
    const base = `${recording.name.replace(/[^\w.-]+/g, "-")}-labelled`;
    try {
      let target: { kind: "folder"; parent: string; name: string } | { kind: "csv"; path: string };
      if (exportFormat === "folder") {
        const parent = await chooseExportFolder("Choose where to put the recording folder");
        if (!parent) return;
        target = { kind: "folder", parent, name: base };
      } else {
        const path = await save({ title: "Export as one CSV", defaultPath: `${base}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
        if (!path) return;
        target = { kind: "csv", path };
      }
      setBusy(true);
      const where = await exportLabellingRecording(recording.source, spans, target);
      OperationFeedback.success("Exported", where);
    } catch (error) {
      setMessage({ tone: "error", text: `Not exported: ${String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  // The Recorder recording a Model Lab recording came from (through the versions it was saved as), where the camera's hand
  // landmarks are kept.
  const recorderId = useMemo(() => {
    if (recording?.source.kind !== "dataset") return null;
    const seen = new Set<string>();
    let id: string | undefined = recording.source.id;
    while (id && !seen.has(id)) {
      seen.add(id);
      const dataset = datasets.find((entry) => entry.id === id);
      if (!dataset) return null;
      if (dataset.sourceRecordingId) return dataset.sourceRecordingId;
      id = dataset.derivedFrom;
    }
    return null;
  }, [recording, datasets]);

  useEffect(() => {
    setCamera(null);
    if (!recording || !recorderId) return;
    let live = true;
    void getRecordingCameraEvidence(recorderId).then((result) => {
      if (!live) return;
      if (result.status === "error") setCamera({ problem: result.message });
      else if (!result.value) setCamera({ problem: "this recording was made with the camera off" });
      else setCamera(cameraTrack(result.value, Number(recording.originNs)));
    });
    return () => {
      live = false;
    };
  }, [recording, recorderId]);

  /** Where the fingers close: from the Gesture library's pinch rule (for the label you are marking, or any pinch). */
  const pinch = useMemo(() => {
    const pinches = definitions.filter((definition) => definition.conditions.some((c) => c.measure === "pinch.index" && c.direction === "below"));
    return pinches.find((definition) => definition.labelId === chosen) ?? pinches[0] ?? null;
  }, [definitions, chosen]);
  const threshold = useMemo(() => contactThreshold(pinch ? [pinch] : [], pinch?.labelId ?? ""), [pinch]);
  const contacts = useMemo(
    () => (camera && "track" in camera ? contactOnsets(camera.track, threshold).map((at) => ({ startMs: at, endMs: at + 20, label: "contact" })) : []),
    [camera, threshold],
  );
  /** Puts the selection's start where the fingers touched, keeping its end when it is later. */
  const pickContact = (contact: Span) =>
    setSelection((current) => ({ startMs: contact.startMs, endMs: current && current.endMs > contact.startMs ? current.endMs : contact.startMs + 1000 }));

  // How late this recording's labels are, for the label most of them have.
  const lagLabel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const span of recording?.labelIntervals ?? []) counts.set(span.label, (counts.get(span.label) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }, [recording]);
  const lag = useMemo(() => {
    if (!recording || !lagLabel) return { camera: null, model: null };
    const starts = recording.labelIntervals.filter((span) => span.label === lagLabel).map((span) => span.startMs);
    const replay = replays?.find((entry) => entry.label === lagLabel);
    return {
      camera: contacts.length > 0 ? lagFromContacts(starts, contacts.map((contact) => contact.startMs)) : null,
      model: replay ? lagFromDetections(starts, replay.detections) : null,
    };
  }, [recording, lagLabel, contacts, replays]);
  const moveLabels = (lagMs: number) => {
    if (!recording) return;
    setHistory((current) => commit(current, shiftRecordedLabels(current.present, recording.labelIntervals, lagMs)));
    feedbackWithUndo("Labels moved", `This recording's recorded labels, ${Math.abs(Math.round(lagMs))} ms ${lagMs >= 0 ? "earlier" : "later"}, as hand labels.`, () => setHistory(undo));
  };

  const runModels = async () => {
    if (!recording) return;
    setReplaying(true);
    try {
      setReplays(await replayActiveModels(recording.source));
    } catch (error) {
      setMessage({ tone: "error", text: `Could not run the model: ${String(error)}` });
    } finally {
      setReplaying(false);
    }
  };

  // Each model's detections, and whether each caught a labelled start of its gesture (by hand where you labelled it).
  // A threshold to try for a model, other than its own: its detections are then where the same scores would start them.
  const [tried, setTried] = useState<Record<string, number>>({});
  useEffect(() => setTried({}), [replays]);
  const checked = useMemo(
    () =>
      (replays ?? []).map((ran) => {
        const threshold = tried[ran.label];
        const point = threshold === undefined ? undefined : ran.sweep?.find((entry) => Math.abs(entry.threshold - threshold) < 1e-6);
        const replay = point
          ? { ...ran, threshold: point.threshold, detections: point.risesMs.map((at) => ({ startMs: at, endMs: at + 40, label: ran.label })) }
          : ran;
        const starts = [...(recording?.labelIntervals ?? []), ...spans].filter((span) => span.label === replay.label).map((span) => span.startMs);
        const caught = caughtStarts(replay.detections, starts);
        return { replay, own: ran.threshold, caught, starts: starts.length };
      }),
    [replays, tried, recording, spans],
  );
  /** A label for everyday activity, which turns a false detection into a training example of what is not the gesture. */
  const everydayLabel = catalogue.find((label) => label.role === "negativeBackground")?.id ?? null;
  const pickDetection = (detection: Span) => {
    setSelection(negativeSpanFor(detection.startMs));
    if (everydayLabel) setChosen(everydayLabel);
  };

  // Stretches worth a look that nobody has labelled, reviewed one at a time.
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState<number | null>(null);
  const closedSpans = useMemo(() => (camera && "track" in camera ? contactSpans(camera.track, threshold) : []), [camera, threshold]);
  const bursts = useMemo(() => {
    if (!recording) return [];
    const gyro = ["gyro_x", "gyro_y", "gyro_z"].map((name) => recording.imu.columns.find((column) => column.name === name)?.values ?? []) as [(number | null)[], (number | null)[], (number | null)[]];
    return gyro[0].length > 0 ? motionBursts(recording.imu.timesMs, gyro) : [];
  }, [recording]);
  const suggestions = useMemo(() => {
    if (!recording) return [];
    return suggestionsFor({
      contacts: closedSpans,
      contactLabel: pinch?.labelId ?? lagLabel,
      falseDetections: checked.flatMap(({ replay, caught }) => replay.detections.filter((_, i) => !caught[i]).map((detection) => ({ startMs: detection.startMs, label: replay.label }))),
      everydayLabel,
      bursts,
      recorded: recording.labelIntervals,
      byHand: spans,
      skipped,
    });
  }, [recording, closedSpans, bursts, pinch, lagLabel, checked, everydayLabel, spans, skipped]);
  const current = reviewing === null ? null : suggestions[Math.min(reviewing, suggestions.length - 1)] ?? null;
  const currentKey = current ? suggestionKey(current) : null;
  // Each suggestion in turn is selected, with its label chosen, in the middle of the view: Enter labels it.
  useEffect(() => {
    if (!current) return;
    setSelection({ startMs: current.startMs, endMs: current.endMs });
    if (current.label) setChosen(current.label);
    setView((shown) => {
      const width = Math.max(shown.endMs - shown.startMs, (current.endMs - current.startMs) * 3);
      const middle = (current.startMs + current.endMs) / 2;
      return shown.startMs <= current.startMs && current.endMs <= shown.endMs ? shown : pan({ startMs: middle - width / 2, endMs: middle + width / 2 }, 0, durationMs);
    });
    // `currentKey` stands for `current`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);
  const step = useCallback(
    (by: number) => setReviewing((index) => (suggestions.length === 0 ? null : Math.max(0, Math.min(suggestions.length - 1, (index ?? 0) + by)))),
    [suggestions.length],
  );
  const skip = useCallback(() => {
    if (!current) return;
    setSkipped((previous) => new Set(previous).add(suggestionKey(current)));
  }, [current]);
  useEffect(() => {
    if (reviewing === null) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") step(1);
      else if (key === "p") step(-1);
      else if (key === "x") skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reviewing, step, skip]);
  useEffect(() => {
    setSkipped(new Set());
    setReviewing(null);
  }, [recording]);

  snapPoints.current = useMemo(
    () => [
      ...closedSpans.flatMap((span) => [span.startMs, span.endMs]),
      ...bursts.flatMap((span) => [span.startMs + 100, span.endMs - 100]),
      ...(recording?.labelIntervals ?? []).flatMap((span) => [span.startMs, span.endMs]),
      ...spans.flatMap((span) => [span.startMs, span.endMs]),
    ].sort((a, b) => a - b),
    [closedSpans, bursts, recording, spans],
  );

  // Where the labels, the camera and the models disagree, to step through with [ and ].
  const hazards = useMemo(() => (recording ? hazardsIn(recording.ppg, recording.imu) : []), [recording]);
  const problems = useMemo(
    () =>
      recording
        ? [...hazards.map((hazard) => ({ atMs: hazard.startMs, text: hazard.text })), ...problemsIn({
            recorded: recording.labelIntervals,
            byHand: spans,
            contacts: camera && "track" in camera ? closedSpans : null,
            gestures: new Set(catalogue.filter((label) => label.role === "positiveGesture").map((label) => label.id)),
            models: checked.map(({ replay }) => ({ label: replay.label, detections: replay.detections })),
            nameOf,
          })].sort((a, b) => a.atMs - b.atMs)
        : [],
    [recording, hazards, spans, camera, closedSpans, catalogue, checked, nameOf],
  );
  const [problemShown, setProblemShown] = useState<Problem | null>(null);
  const goToProblem = useCallback(
    (direction: 1 | -1) => {
      // From the one shown, or else from the edge of the view, so a problem right at the edge is found too.
      const from = problemShown?.atMs ?? (direction === 1 ? view.startMs - 100 : view.endMs + 100);
      const next = nextProblem(problems, from, direction);
      if (!next) return;
      setProblemShown(next);
      setView((shown) => {
        const width = Math.min(shown.endMs - shown.startMs, FOCUS_SPAN_MS);
        return pan({ startMs: next.atMs - width / 2, endMs: next.atMs + width / 2 }, 0, durationMs);
      });
    },
    [problems, problemShown, view, durationMs],
  );
  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key === "]") goToProblem(1);
      else if (event.key === "[") goToProblem(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, goToProblem]);
  useEffect(() => setProblemShown(null), [recording]);

  const overviewMarks = useMemo<OverviewMark[]>(
    () => [
      ...problems.map((problem) => ({ atMs: problem.atMs, color: "#fb923c", title: problem.text })),
      ...suggestions.map((suggestion) => ({ atMs: suggestion.startMs, color: "rgba(148,163,184,.9)", title: `Suggested: ${suggestion.reason}` })),
      ...checked.flatMap(({ replay, caught }) =>
        replay.detections.map((detection, i) => ({ atMs: detection.startMs, color: caught[i] ? "#4ade80" : "#f87171", title: `${replay.label} model: ${caught[i] ? "caught" : "false?"}` })),
      ),
    ],
    [problems, suggestions, checked],
  );

  const lanes = recording
    ? [...recording.ppg.columns.map((column) => ({ column, times: recording.ppg.timesMs })), ...recording.imu.columns.map((column) => ({ column, times: recording.imu.timesMs }))]
    : [];
  const shown = lanes.filter(({ column }) => !hidden.includes(column.name));
  const currentSource = recording?.source.kind === "dataset" ? recording.source.id : "";
  const openDataset = datasets.find((dataset) => dataset.id === currentSource) ?? null;

  if (!desktopAvailable) {
    return (
      <main className="shell">
        <p className="hint">Labelling reads recordings through the desktop app, so it is unavailable in browser preview.</p>
      </main>
    );
  }

  return (
    <main className="shell labelling-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Spatial Gesture Control</p>
          <h1>Labelling</h1>
          <p className="subtitle">Mark gestures by hand on a recording's signals. Hand labels win over the recorder's and the camera's wherever you set them.</p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <SectionHeader
            title="Recording"
            description="Open a recording from Model Lab, or a dataset folder or CSV exported by the Recorder. Files without a manual_label column get one."
            status={dirty ? <Badge variant="outline">Unsaved labels</Badge> : null}
          />
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="field min-w-64">
            <Label htmlFor="labelling-dataset">Model Lab recording</Label>
            <Select value={currentSource} onValueChange={(id) => id && request({ kind: "dataset", id })}>
              <SelectTrigger id="labelling-dataset" aria-label="Model Lab recording">
                <SelectValue placeholder="Choose a recording">
                  {(id: string) => {
                    const dataset = datasets.find((entry) => entry.id === id);
                    return dataset ? `#${dataset.sequence ?? "?"} ${dataset.originalFilename}` : id;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {datasets.map((dataset) => (
                  <SelectItem key={dataset.id} value={dataset.id}>
                    #{dataset.sequence ?? "?"} {dataset.originalFilename}
                    {dataset.label ? ` (${dataset.label})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={() => void chooseFile(false)} disabled={busy}>Open CSV…</Button>
          <Button variant="outline" onClick={() => void chooseFile(true)} disabled={busy}>Open folder…</Button>
          {recording && (
            <span className="hint">
              Open: <strong>{recording.name}</strong> · {formatSeconds(recording.durationMs)}
              {recording.context && Object.keys(recording.context).length > 0 ? ` · recorded ${describeContext(recording.context)}` : ""}
            </span>
          )}
        </CardContent>
      </Card>

      {message && (
        <Alert variant={message.tone === "error" ? "destructive" : "default"} role={message.tone === "error" ? "alert" : "status"}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      {recording && (
        <Card>
          <CardHeader>
            <SectionHeader
              title="Signals"
              description="Drag across any graph to select. Ctrl/⌘+scroll or a pinch zooms where the cursor is; Shift+scroll or a sideways swipe moves along. Arrow keys move the selection's end (Alt: its start, Shift: five times as far). Press ? for every shortcut."
            />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Labels">
              {catalogue.map((label, index) => (
                <Button
                  key={label.id}
                  size="sm"
                  variant={chosen === label.id ? "default" : "outline"}
                  onClick={() => setChosen(label.id)}
                  aria-pressed={chosen === label.id}
                >
                  <span className="labelling-swatch" style={{ background: colorOf(label.id) }} aria-hidden="true" />
                  {label.displayName || label.id}
                  {index < 9 && <kbd className="labelling-key">{index + 1}</kbd>}
                </Button>
              ))}
              <Button size="sm" variant={chosen === NO_LABEL ? "default" : "outline"} onClick={() => setChosen(NO_LABEL)} aria-pressed={chosen === NO_LABEL}>
                <span className="labelling-swatch" style={{ background: colorOf(NO_LABEL) }} aria-hidden="true" />
                Nothing here <kbd className="labelling-key">0</kbd>
              </Button>
              <Button
                size="sm"
                variant={chosen === LEFT_OUT ? "default" : "outline"}
                onClick={() => setChosen(LEFT_OUT)}
                aria-pressed={chosen === LEFT_OUT}
                title="For a stretch with bad data (strap loose, poor contact, the watch knocked): it stays in the recording and is never trained on, nor counted in a test"
              >
                <span className="labelling-swatch" style={{ background: colorOf(LEFT_OUT) }} aria-hidden="true" />
                Leave out <kbd className="labelling-key">L</kbd>
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => applyLabel(chosen)} disabled={!selection}>Label selection: {nameOf(chosen)} <kbd className="labelling-key">Enter</kbd></Button>
              <Button variant="outline" onClick={() => applyLabel(null)} disabled={!selection}>Erase hand label <kbd className="labelling-key">⌫</kbd></Button>
              <Button variant="outline" onClick={() => setHistory(undo)} disabled={history.past.length === 0}>Undo</Button>
              <Button variant="outline" onClick={() => setHistory(redo)} disabled={history.future.length === 0}>Redo</Button>
              <span className="mx-2 h-6 w-px bg-border" aria-hidden="true" />
              <Button variant="outline" size="sm" onClick={() => setView((v) => zoom(v, (v.startMs + v.endMs) / 2, 0.5, durationMs))}>Zoom in</Button>
              <Button variant="outline" size="sm" onClick={() => setView((v) => zoom(v, (v.startMs + v.endMs) / 2, 2, durationMs))}>Zoom out</Button>
              <Button variant="outline" size="sm" onClick={() => setView({ startMs: 0, endMs: durationMs })}>Whole recording</Button>
              {selection && (
                <Button variant="outline" size="sm" onClick={() => setView(zoom({ startMs: selection.startMs, endMs: selection.endMs }, (selection.startMs + selection.endMs) / 2, 1.5, durationMs))}>
                  Zoom to selection
                </Button>
              )}
            </div>
            <p className="hint" aria-live="polite">
              {camera && "track" in camera
                ? `Camera: ${camera.track.frames} frames, lined up with the watch to about ${Math.round(camera.track.jitterMs)} ms; click a yellow mark to start the selection where the fingers touched. `
                : camera && "problem" in camera && recorderId
                  ? `No camera contact: ${camera.problem}. `
                  : ""}
              {selection ? `Selected ${formatSeconds(selection.startMs)} to ${formatSeconds(selection.endMs)} (${Math.round(selection.endMs - selection.startMs)} ms). ` : "Nothing selected. "}
              {hoverMs !== null ? `Cursor at ${formatSeconds(hoverMs)}. ` : ""}
              Showing {formatSeconds(view.startMs)} to {formatSeconds(view.endMs)}.
            </p>

            <div className="labelling-suggestions" role="region" aria-label="Problems">
              <span>
                <strong>{problems.length} place{problems.length === 1 ? "" : "s"} to check</strong>{" "}
                <span className="hint">
                  {problemShown ? `At ${formatSeconds(problemShown.atMs)}: ${problemShown.text}.` : "Where the data is suspect, where the labels, the camera and the models disagree, or where a hold is too short to train on (orange on the overview)."}
                </span>
              </span>
              <span className="flex gap-2">
                <Button size="sm" variant="outline" disabled={problems.length === 0} onClick={() => goToProblem(-1)}>Previous <kbd className="labelling-key">[</kbd></Button>
                <Button size="sm" variant="outline" disabled={problems.length === 0} onClick={() => goToProblem(1)}>Next <kbd className="labelling-key">]</kbd></Button>
              </span>
            </div>
            <div className="labelling-suggestions" role="region" aria-label="Suggestions">
              {reviewing === null || !current ? (
                <>
                  <span>
                    <strong>{suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}</strong>{" "}
                    <span className="hint">
                      {suggestions.length === 0 && reviewing !== null ? "Reviewed them all. " : ""}
                      Unlabelled stretches worth a look: where the camera saw the fingers close, where a model fired (run it below), and where the wrist turned sharply.
                    </span>
                  </span>
                  <Button size="sm" variant="outline" disabled={suggestions.length === 0} onClick={() => setReviewing(0)}>Review them</Button>
                </>
              ) : (
                <>
                  <span>
                    <strong>{Math.min(reviewing, suggestions.length - 1) + 1} of {suggestions.length}:</strong> {current.reason}
                    {current.label ? `, likely ${nameOf(current.label)}.` : "; choose what it is."}
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => applyLabel(current.label ?? chosen)}>Label it {nameOf(current.label ?? chosen)} <kbd className="labelling-key">Enter</kbd></Button>
                    <Button size="sm" variant="outline" onClick={skip}>Skip <kbd className="labelling-key">X</kbd></Button>
                    <Button size="sm" variant="outline" onClick={() => step(-1)}>Previous <kbd className="labelling-key">P</kbd></Button>
                    <Button size="sm" variant="outline" onClick={() => step(1)}>Next <kbd className="labelling-key">N</kbd></Button>
                    <Button size="sm" variant="ghost" onClick={() => setReviewing(null)}>Stop reviewing</Button>
                  </span>
                </>
              )}
            </div>

            <div className="flex items-stretch gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <OverviewStrip
                  durationMs={durationMs}
                  recorded={recording.labelIntervals}
                  byHand={spans}
                  marks={overviewMarks}
                  view={view}
                  colorOf={colorOf}
                  onView={setView}
                />
                <p className="hint">The whole recording: recorded labels above, yours below. Click or drag to look elsewhere.</p>
              </div>
              {camera && "track" in camera && <HandPreview hands={hoverMs === null ? null : handsAt(camera.track, hoverMs)} atLabel={hoverMs === null ? "" : formatSeconds(hoverMs)} />}
            </div>

            <div className="labelling-timeline">
              <SpanRail title="Recorded" spans={recording.labelIntervals} view={view} colorOf={colorOf} nameOf={nameOf} />
              <SpanRail title="By hand" spans={spans} view={view} colorOf={colorOf} nameOf={nameOf} />
              {hazards.length > 0 && (
                <SpanRail
                  title="Data"
                  spans={hazards.map((hazard) => ({ startMs: hazard.startMs, endMs: hazard.endMs, label: hazard.text }))}
                  view={view}
                  colorOf={colorOf}
                  nameOf={nameOf}
                  colorFor={() => "#f97316"}
                  nameFor={(span) => span.label}
                  onPick={(span) => {
                    setSelection({ startMs: span.startMs, endMs: span.endMs });
                    setChosen(LEFT_OUT);
                  }}
                  pickTitle="Select it, ready to leave out"
                />
              )}
              {suggestions.length > 0 && (
                <SpanRail
                  title="Suggested"
                  spans={suggestions.map((suggestion) => ({ startMs: suggestion.startMs, endMs: suggestion.endMs, label: suggestion.label ?? "?" }))}
                  view={view}
                  colorOf={colorOf}
                  nameOf={nameOf}
                  colorFor={(span, index) => (suggestions[index] && current && suggestionKey(suggestions[index]) === currentKey ? "#fbbf24" : "rgba(148,163,184,.7)")}
                  nameFor={(_, index) => suggestions[index]?.source ?? ""}
                  onPick={(_, index) => setReviewing(index)}
                  pickTitle="Review this suggestion"
                />
              )}
              {contacts.length > 0 && (
                <SpanRail
                  title="Camera contact"
                  spans={contacts}
                  view={view}
                  colorOf={colorOf}
                  nameOf={nameOf}
                  colorFor={() => "#fbbf24"}
                  nameFor={() => ""}
                  onPick={pickContact}
                  pickTitle="Start the selection where the fingers touched"
                />
              )}
              {checked.map(({ replay, caught }) => (
                <SpanRail
                  key={`model-${replay.label}`}
                  title={`Model: ${nameOf(replay.label)}`}
                  spans={replay.detections}
                  view={view}
                  colorOf={colorOf}
                  nameOf={nameOf}
                  colorFor={(_, index) => (caught[index] ? "#4ade80" : "#f87171")}
                  nameFor={(_, index) => (caught[index] ? "caught" : "false?")}
                  onPick={pickDetection}
                  pickTitle="Select the stretch that makes it a training example"
                />
              ))}
              <div
                ref={area}
                className="labelling-lanes"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={() => setHoverMs(null)}
              >
                {camera && "track" in camera && (
                  <SignalLane
                    name="Camera: thumb to index"
                    timesMs={camera.track.timesMs}
                    values={camera.track.values}
                    view={view}
                    width={width}
                    height={LANE_HEIGHTS[laneSize]}
                    spans={spans}
                    colorOf={colorOf}
                    selection={selection}
                    hoverMs={hoverMs}
                    fitToView={fitToView}
                    guide={threshold}
                  />
                )}
                {checked.map(({ replay }) => (
                  <SignalLane
                    key={`score-${replay.label}`}
                    name={`${nameOf(replay.label)} score`}
                    timesMs={replay.timesMs}
                    values={replay.scores}
                    view={view}
                    width={width}
                    height={LANE_HEIGHTS[laneSize]}
                    spans={spans}
                    colorOf={colorOf}
                    selection={selection}
                    hoverMs={hoverMs}
                    scale={{ low: 0, high: 1 }}
                    guide={replay.threshold}
                  />
                ))}
                {shown.map(({ column, times }) => (
                  <SignalLane
                    key={column.name}
                    name={COLUMN_TITLES[column.name] ?? column.name}
                    timesMs={times}
                    values={column.values}
                    view={view}
                    width={width}
                    height={LANE_HEIGHTS[laneSize]}
                    spans={spans}
                    colorOf={colorOf}
                    selection={selection}
                    hoverMs={hoverMs}
                    fitToView={fitToView}
                  />
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="hint">Graph height</span>
              {(Object.keys(LANE_HEIGHTS) as LaneSize[]).map((size) => (
                <Button key={size} size="sm" variant={laneSize === size ? "default" : "outline"} onClick={() => setLaneSize(size)} aria-pressed={laneSize === size}>
                  {size === "compact" ? "Compact" : size === "normal" ? "Normal" : "Tall"}
                </Button>
              ))}
              <span className="mx-2 h-6 w-px bg-border" aria-hidden="true" />
              <label className="flex items-center gap-1">
                <Checkbox checked={snap} onCheckedChange={(on) => setSnap(Boolean(on))} aria-label="Snap the selection" />
                Snap the selection to contacts, sharp moves and label edges (hold Alt not to)
              </label>
              <span className="mx-2 h-6 w-px bg-border" aria-hidden="true" />
              <span className="hint">Scale</span>
              <Button size="sm" variant={!fitToView ? "default" : "outline"} onClick={() => setFitToView(false)} aria-pressed={!fitToView}>Whole recording</Button>
              <Button size="sm" variant={fitToView ? "default" : "outline"} onClick={() => setFitToView(true)} aria-pressed={fitToView}>Fit to view</Button>
            </div>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Columns shown">
              {lanes.map(({ column }) => (
                <label key={column.name} className="flex items-center gap-1 text-sm">
                  <Checkbox
                    checked={!hidden.includes(column.name)}
                    onCheckedChange={(on) => setHidden((current) => (on ? current.filter((name) => name !== column.name) : [...current, column.name]))}
                  />
                  {COLUMN_TITLES[column.name] ?? column.name}
                </label>
              ))}
            </fieldset>
          </CardContent>
        </Card>
      )}

      {recording && (
        <Card>
          <CardHeader>
            <SectionHeader
              title="Check the model"
              description="Runs your active models over this recording exactly as the app runs them live (in Monitor: nothing acts). Each model's score is drawn above the signals, and its detections on a rail: green where one comes 0.68 to 1.28 s after a start of its gesture, red where it does not. Click a red one to select the stretch that makes it a training example of what is not the gesture, then label it with an everyday-activity label (Enter)."
            />
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={() => void runModels()} disabled={replaying || busy}>
                {replaying ? "Running…" : replays ? "Run again" : "Run the active models"}
              </Button>
              {replays && replays.length === 0 && <span className="hint">No model is active.</span>}
            </div>
            {checked.map(({ replay, own, caught, starts }) => {
              const hits = caught.filter(Boolean).length;
              const sweep = replays?.find((ran) => ran.label === replay.label)?.sweep ?? [];
              return (
                <div key={replay.label} className="flex flex-col gap-1">
                  <p className="hint">
                    <strong>{nameOf(replay.label)}</strong> ({replay.version}, threshold {replay.threshold.toFixed(2)}{replay.threshold !== own ? `, trying it instead of its own ${own.toFixed(2)}` : ""}): {replay.detections.length} detections, {hits} catching one of the {starts} labelled starts and {replay.detections.length - hits} elsewhere.
                    {replay.rejections.length > 0 ? ` Some stretches were not scored: ${replay.rejections.join("; ")}.` : ""}
                  </p>
                  {sweep.length > 0 && (
                    <label className="flex flex-wrap items-center gap-2 text-sm">
                      Try another threshold
                      <input
                        type="range"
                        aria-label={`Threshold to try for ${nameOf(replay.label)}`}
                        min={sweep[0].threshold}
                        max={sweep[sweep.length - 1].threshold}
                        step={0.05}
                        value={replay.threshold}
                        onChange={(event) => setTried((current) => ({ ...current, [replay.label]: Math.round(Number(event.target.value) * 100) / 100 }))}
                      />
                      {replay.threshold !== own && <Button size="sm" variant="ghost" onClick={() => setTried((current) => { const { [replay.label]: _, ...rest } = current; return rest; })}>Back to its own</Button>}
                    </label>
                  )}
                </div>
              );
            })}
            {checked.some(({ replay, own }) => replay.threshold !== own) && (
              <p className="hint">A threshold you try changes only what is shown here, not the model: the same scores, through the same detection rule.</p>
            )}
            {replays && replays.length > 0 && !everydayLabel && (
              <p className="hint">Tip: add a label with the everyday-activity role on the Labels page to mark false detections with.</p>
            )}
          </CardContent>
        </Card>
      )}

      {recording && lagLabel && (
        <Card role="region" aria-label="Label timing">
          <CardHeader>
            <SectionHeader
              title="Label timing"
              description={`How late this recording's ${nameOf(lagLabel)} labels start, as far as the camera or the model can tell. Labels from the recorder or camera marking are often a few hundred milliseconds late, by a different amount in each recording; moving them makes training learn the right moment. The move is made as hand labels, so Undo or Erase takes it back.`}
            />
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {lag.camera ? (
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  <strong>Camera:</strong> the labels start {Math.abs(Math.round(lag.camera.lagMs))} ms {lag.camera.lagMs >= 0 ? "after" : "before"} the fingers touch (median of {lag.camera.pairs} starts; the clocks line up to about {camera && "track" in camera ? Math.round(camera.track.jitterMs) : "?"} ms).
                </span>
                <Button size="sm" variant="outline" onClick={() => moveLabels(lag.camera!.lagMs)}>Move the labels to the camera</Button>
              </div>
            ) : (
              <p className="hint">Camera: {camera && "track" in camera ? "too few label starts near a camera contact to tell." : "no camera data for this recording."}</p>
            )}
            {lag.model ? (
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  <strong>Model:</strong> its detections catch the most starts ({lag.model.caught}, against {lag.model.caughtAsIs} as labelled) with the labels {Math.abs(Math.round(lag.model.lagMs))} ms {lag.model.lagMs >= 0 ? "earlier" : "later"}. A model trained on late labels learns their lateness, so the camera is the better guide where there is one.
                </span>
                <Button size="sm" variant="outline" onClick={() => moveLabels(lag.model!.lagMs)}>Move the labels to the model</Button>
              </div>
            ) : (
              <p className="hint">Model: {replays ? "its detections catch no start at any shift." : "run the active models (above) to see how they line up."}</p>
            )}
          </CardContent>
        </Card>
      )}

      {recording && (
        <Card>
          <CardHeader>
            <SectionHeader
              title="Keep it"
              description="Save makes a new recording in Model Lab with these labels and leaves this one as it was, so models trained on it stay tied to the data they learned from. Export writes the recording with its labels for keeping or sharing."
            />
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-4">
            <Button onClick={() => void saveVersion()} disabled={busy || !dirty}>Save as new version</Button>
            <RadioGroup value={exportFormat} onValueChange={(value) => setExportFormat(value as ExportFormat)} className="flex gap-4" aria-label="Export as">
              <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="folder" /> Folder of two files (ppg.csv, imu.csv)</label>
              <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="csv" /> One CSV</label>
            </RadioGroup>
            <Button variant="outline" onClick={() => void exportIt()} disabled={busy}>Export…</Button>
          </CardContent>
        </Card>
      )}

      {recording && openDataset && (
        <ReviewStatus
          dataset={openDataset}
          dirty={dirty}
          onChanged={(updated) => setDatasets((current) => current.map((dataset) => (dataset.id === updated.id ? updated : dataset)))}
        />
      )}

      <AlertDialog open={pendingSource !== null} onOpenChange={(openNow) => !openNow && setPendingSource(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved labels?</AlertDialogTitle>
            <AlertDialogDescription>The hand labels on {recording?.name} are not saved. Opening another recording drops them.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep working</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const next = pendingSource;
                setPendingSource(null);
                if (next) void load(next.source, next.focus);
              }}
            >
              Discard and open
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

/** The nearest ancestor that scrolls up and down, or the page itself. */
function scrollParentOf(element: HTMLElement): Element {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** A wheel delta in pixels, whether the device reported pixels, lines or pages. */
function pixels(event: WheelEvent, delta: number, element: HTMLElement): number {
  if (event.deltaMode === 1) return delta * 16;
  if (event.deltaMode === 2) return delta * (element.ownerDocument.documentElement.clientHeight || 800);
  return delta;
}

/** One row of spans over the view, each a block in its colour with its name; clickable when `onPick` is given. */
function SpanRail({
  title,
  spans,
  view,
  colorOf,
  nameOf,
  colorFor,
  nameFor,
  onPick,
  pickTitle = "Click to select it",
}: {
  title: string;
  spans: Span[];
  view: View;
  colorOf: (label: string) => string;
  nameOf: (label: string) => string;
  colorFor?: (span: Span, index: number) => string;
  nameFor?: (span: Span, index: number) => string;
  onPick?: (span: Span, index: number) => void;
  /** What clicking a span does, for its tooltip. */
  pickTitle?: string;
}) {
  const width = Math.max(1e-9, view.endMs - view.startMs);
  return (
    <div className="labelling-rail" aria-label={`${title} labels`} role="list">
      <span className="labelling-lane-name">{title}</span>
      {spans.map((span, index) => {
        if (span.endMs < view.startMs || span.startMs > view.endMs) return null;
        const left = Math.max(0, ((span.startMs - view.startMs) / width) * 100);
        const right = Math.min(100, ((span.endMs - view.startMs) / width) * 100);
        const name = nameFor ? nameFor(span, index) : nameOf(span.label);
        const style = { left: `${left}%`, width: `max(${onPick ? 6 : 2}px, ${right - left}%)`, background: colorFor ? colorFor(span, index) : colorOf(span.label) };
        const tip = `${name}: ${formatSeconds(span.startMs)} to ${formatSeconds(span.endMs)}`;
        return onPick ? (
          <button key={`${span.startMs}-${index}`} type="button" role="listitem" className="labelling-span" title={`${tip}. ${pickTitle}`} style={style} onClick={() => onPick(span, index)}>
            {name}
          </button>
        ) : (
          <span key={`${span.startMs}-${index}`} role="listitem" className="labelling-span" title={tip} style={style}>
            {name}
          </span>
        );
      })}
    </div>
  );
}
