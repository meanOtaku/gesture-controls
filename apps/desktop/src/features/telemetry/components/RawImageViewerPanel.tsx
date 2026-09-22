import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { Skeleton } from "../../../components/ui/skeleton";
import { Slider } from "../../../components/ui/slider";
import {
  deleteRecordingBundle,
  getRecordingQualitySummary,
  importRecordingFromRawCsv,
  listRecordingBundles,
  loadRecordingBundle,
  RAW_GRID_SIZES,
  RAW_IMAGE_VIEWER_CHANNELS,
  rawWindowMaxValues,
  rawWindowRowHop,
  type AnnotationInterval,
  type RawGridSize,
  type RawImageViewerChannel,
  type RecordingBundleSummary,
  type RecordingQualitySummary,
} from "../../../shared/tauri/recordingBundle";
import { deriveVisibleLabelRanges } from "../annotations/visibleLabelRanges";
import { rawImageViewerStore } from "../store/rawImageViewerStore";
import { RawImageCanvas } from "./RawImageCanvas";
import { RawImageLabelRangeRail } from "./RawImageLabelRangeRail";
import { RecordingQualitySummaryCard } from "./RecordingQualitySummaryCard";

type LabelRangesState =
  | { status: "empty" }
  | { status: "loading" }
  | { status: "loaded"; intervals: AnnotationInterval[] }
  | { status: "error"; message: string };

type RecordingListState =
  | { status: "loading" }
  | { status: "loaded"; recordings: RecordingBundleSummary[] }
  | { status: "error"; message: string };

type QualitySummaryState =
  | { status: "empty" }
  | { status: "loading" }
  | { status: "loaded"; summary: RecordingQualitySummary }
  | { status: "error"; message: string };

function channelLabel(channel: RawImageViewerChannel): string {
  return channel.replaceAll("_", " ");
}

function recordingLabel(summary: RecordingBundleSummary): string {
  const seconds = (summary.actualDurationMs / 1000).toFixed(1);
  return `${summary.recordingId} · ${summary.rawRowCount.toLocaleString()} rows · ${seconds}s`;
}

/**
 * Dedicated, read-only raw-data inspection panel: select a saved recording,
 * an allow-listed numeric channel, and an allow-listed square grid size
 * (every multiple of 4 from 4×4 through 64×64, default 64×64), then inspect a
 * chronological N×N image with exactly N raw rows per navigation step,
 * rendered as a grayscale image and a paired rainbow false-colour image of
 * the identical window (GC-013). This panel never edits annotations, never
 * writes raw.csv, and offers no training action — see GC-009's delivery plan
 * for the original fixed scope and GC-012 for the bounded dynamic grid size.
 */
export function RawImageViewerPanel() {
  const [recordingList, setRecordingList] = useState<RecordingListState>({ status: "loading" });
  const [listVersion, setListVersion] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccessMessage, setImportSuccessMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [labelRanges, setLabelRanges] = useState<LabelRangesState>({ status: "empty" });
  const labelRangesRequestVersion = useRef(0);
  const [qualitySummary, setQualitySummary] = useState<QualitySummaryState>({ status: "empty" });
  const qualitySummaryRequestVersion = useRef(0);
  useSyncExternalStore(rawImageViewerStore.subscribe, rawImageViewerStore.getVersion, rawImageViewerStore.getVersion);

  const handleImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    setImportError(null);
    setImportSuccessMessage(null);
    try {
      const csvText = await file.text();
      const result = await importRecordingFromRawCsv(csvText);
      if (result.status === "error") {
        setImportError(result.message);
        return;
      }
      setListVersion((v) => v + 1);
      rawImageViewerStore.setRecording(result.recordingId);
      setImportSuccessMessage(
        `Imported recording ${result.recordingId} (${result.rowCount.toLocaleString()} rows).`,
      );
    } finally {
      setImporting(false);
    }
  };

  const handleDeleteRecording = async (summary: RecordingBundleSummary) => {
    const confirmed = window.confirm(
      `Permanently delete recording ${summary.recordingId}? This cannot be undone.`,
    );
    if (!confirmed) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await deleteRecordingBundle(summary.recordingId);
      if (result.status === "error") {
        setDeleteError(result.message);
        return;
      }
      rawImageViewerStore.setRecording(null);
      setListVersion((v) => v + 1);
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setRecordingList({ status: "loading" });
    void listRecordingBundles().then((result) => {
      if (cancelled) return;
      if (result.status === "error") {
        setRecordingList({ status: "error", message: result.message });
      } else {
        setRecordingList({ status: "loaded", recordings: result.value });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [listVersion]);

  const recordingId = rawImageViewerStore.getRecordingId();

  // Loads the selected recording's saved annotations (never raw.csv) purely
  // for display; request-version-guarded so a stale/out-of-order response for
  // a since-abandoned recording can never land on the current selection.
  useEffect(() => {
    const requestVersion = ++labelRangesRequestVersion.current;
    if (recordingId === null) {
      setLabelRanges({ status: "empty" });
      return;
    }
    setLabelRanges({ status: "loading" });
    void loadRecordingBundle(recordingId).then((result) => {
      if (requestVersion !== labelRangesRequestVersion.current) return;
      if (result.status === "error") {
        setLabelRanges({ status: "error", message: result.message });
      } else {
        setLabelRanges({ status: "loaded", intervals: result.value.annotations.intervals });
      }
    });
  }, [recordingId]);

  // Loads the derived-only recording/collection quality summary (M1) for the
  // selected saved recording; request-version-guarded like the label-range
  // load above so a stale response for an abandoned selection never lands.
  useEffect(() => {
    const requestVersion = ++qualitySummaryRequestVersion.current;
    if (recordingId === null) {
      setQualitySummary({ status: "empty" });
      return;
    }
    setQualitySummary({ status: "loading" });
    void getRecordingQualitySummary(recordingId).then((result) => {
      if (requestVersion !== qualitySummaryRequestVersion.current) return;
      if (result.status === "error") {
        setQualitySummary({ status: "error", message: result.message });
      } else {
        setQualitySummary({ status: "loaded", summary: result.value });
      }
    });
  }, [recordingId]);

  const channel = rawImageViewerStore.getChannel();
  const normalizationMode = rawImageViewerStore.getNormalizationMode();
  const gridSize = rawImageViewerStore.getGridSize();
  const status = rawImageViewerStore.getStatus();
  const errorMessage = rawImageViewerStore.getErrorMessage();
  const rawWindow = rawImageViewerStore.getWindow();
  const bounds = rawImageViewerStore.getNavigationBounds();
  const requestedStartRawRow = rawImageViewerStore.getRequestedStartRawRow();
  const derivativeStatus = rawImageViewerStore.getDerivativeStatus();
  const derivativeErrorMessage = rawImageViewerStore.getDerivativeErrorMessage();
  const derivativeWindow = rawImageViewerStore.getDerivativeWindow();
  const sampleOrderPreviewStatus = rawImageViewerStore.getSampleOrderPreviewStatus();
  const sampleOrderPreviewErrorMessage = rawImageViewerStore.getSampleOrderPreviewErrorMessage();
  const sampleOrderPreviewWindow = rawImageViewerStore.getSampleOrderPreviewWindow();

  const rowHop = rawWindowRowHop(gridSize);
  const maxValues = rawWindowMaxValues(gridSize);
  const totalFrames = bounds ? Math.floor(bounds.maxStartRawRow / rowHop) + 1 : null;
  const currentFrame = Math.floor(requestedStartRawRow / rowHop) + 1;

  const visibleLabelRanges = useMemo(() => {
    if (rawWindow === null || labelRanges.status !== "loaded") return [];
    return deriveVisibleLabelRanges(labelRanges.intervals, rawWindow.startRawRow, rawWindow.endRawRow);
  }, [rawWindow, labelRanges]);

  return (
    <Card role="region" aria-label="Raw image viewer" className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Raw image viewer
          <HelpTooltip label="About the raw image viewer">
            Read-only visual inspection of one saved recording's raw sensor channel, reshaped
            into a chronological N×N image (pixel <em>i</em> is raw row <code>startRawRow + i</code>,
            left-to-right then top-to-bottom) for an allow-listed grid size N (every multiple of 4
            from 4 through 64; default 64), with an N-row navigation hop. It never edits annotations, never writes
            raw.csv, and is not a training-data representation.
          </HelpTooltip>
        </CardTitle>
        <CardDescription>
          Select a saved recording, numeric channel, and grid size to inspect its raw samples as an image.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Input
            ref={importFileInputRef}
            type="file"
            accept=".csv"
            hidden
            onChange={(event) => {
              void handleImportFileChange(event);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => importFileInputRef.current?.click()}
              disabled={importing}
              aria-busy={importing}
            >
              {importing ? "Importing…" : "Import raw.csv"}
            </Button>
            <HelpTooltip label="About importing a raw.csv recording">
              Imports a Timeline Capture <code>raw.csv</code> file (the app&apos;s exact 16-column export
              schema) or a legacy dataset CSV export (the app&apos;s exact 17-column export schema, label
              column included) as a new, read-only recording for inspection here. It creates no
              annotations and is never used for training.
            </HelpTooltip>
          </div>
          {importError && (
            <p role="alert" className="text-sm text-destructive">
              Could not import this file: {importError}
            </p>
          )}
          {importSuccessMessage && (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {importSuccessMessage}
            </p>
          )}
          {deleteError && (
            <p role="alert" className="text-sm text-destructive">
              Could not delete this recording: {deleteError}
            </p>
          )}
        </div>

        {recordingList.status === "loading" && (
          <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-40" />
          </div>
        )}

        {recordingList.status === "error" && (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-sm text-destructive">
              Could not load saved recordings: {recordingList.message}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => setListVersion((v) => v + 1)}>
              Retry
            </Button>
          </div>
        )}

        {recordingList.status === "loaded" && recordingList.recordings.length === 0 && (
          <p className="hint">No saved recordings yet. Save a Timeline Capture recording bundle to inspect it here.</p>
        )}

        {recordingList.status === "loaded" && recordingList.recordings.length > 0 && (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="raw-viewer-recording">Recording</Label>
                <div className="flex items-center gap-1">
                  {(() => {
                    const selectedSummary = recordingList.recordings.find((summary) => summary.recordingId === recordingId);
                    return (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={selectedSummary ? `Delete recording ${selectedSummary.recordingId}` : "Delete recording"}
                        title="Permanently delete the selected recording"
                        disabled={!selectedSummary || deleting}
                        aria-busy={deleting}
                        onClick={() => {
                          if (selectedSummary) void handleDeleteRecording(selectedSummary);
                        }}
                      >
                        ×
                      </Button>
                    );
                  })()}
                  <Select
                    value={recordingId ?? ""}
                    onValueChange={(value) => rawImageViewerStore.setRecording(value === "" ? null : value)}
                  >
                    <SelectTrigger id="raw-viewer-recording" aria-label="Saved recording" className="min-w-64">
                      <SelectValue placeholder="Select a recording…" />
                    </SelectTrigger>
                    <SelectContent>
                      {recordingList.recordings.map((summary) => (
                        <SelectItem key={summary.recordingId} value={summary.recordingId}>
                          {recordingLabel(summary)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="raw-viewer-channel">Channel</Label>
                <Select
                  value={channel ?? ""}
                  onValueChange={(value) =>
                    rawImageViewerStore.setChannel(value === "" ? null : (value as RawImageViewerChannel))
                  }
                >
                  <SelectTrigger id="raw-viewer-channel" aria-label="Numeric channel" className="min-w-40">
                    <SelectValue placeholder="Select a channel…" />
                  </SelectTrigger>
                  <SelectContent>
                    {RAW_IMAGE_VIEWER_CHANNELS.map((candidate) => (
                      <SelectItem key={candidate} value={candidate}>
                        {channelLabel(candidate)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="raw-viewer-grid-size">
                  Grid size ({gridSize}×{gridSize}, {rowHop}-row hop)
                </Label>
                <Select
                  value={String(gridSize)}
                  onValueChange={(value) => rawImageViewerStore.setGridSize(Number(value) as RawGridSize)}
                >
                  <SelectTrigger id="raw-viewer-grid-size" aria-label="Image grid size" className="min-w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RAW_GRID_SIZES.map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size}×{size} ({size}-row hop)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <fieldset className="flex flex-col gap-1">
                <legend className="label">Normalization</legend>
                <RadioGroup
                  className="flex flex-row gap-4"
                  value={normalizationMode}
                  onValueChange={(value) => {
                    if (value === "recording" || value === "frame") rawImageViewerStore.setNormalizationMode(value);
                  }}
                >
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="recording" aria-label="Recording-scale normalization (default)" />
                    Recording-scale (default)
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="frame" aria-label="Frame-scale normalization" />
                    Frame-scale
                  </label>
                </RadioGroup>
              </fieldset>
            </div>

            {qualitySummary.status === "loaded" && <RecordingQualitySummaryCard summary={qualitySummary.summary} />}
            {qualitySummary.status === "error" && (
              <p role="alert" className="text-xs text-destructive">
                Could not load recording quality summary: {qualitySummary.message}
              </p>
            )}

            {recordingId === null || channel === null ? (
              <p className="hint">Select a recording and a channel to inspect its raw image.</p>
            ) : rawWindow !== null ? (
              // Keep the already-loaded window mounted while a Next/Previous/slider
              // navigation reload is in flight (`status === "loading"` with a
              // still-valid `rawWindow`): swapping this whole block for the tiny
              // Skeleton below on every step collapses and re-expands the page's
              // height, which resets scroll position. A brand-new selection nulls
              // `rawWindow` first (see `resetAndReload`), so that case still shows
              // the loading skeleton below as before.
              <div className="flex flex-col gap-3" aria-busy={status === "loading"}>
                {!rawWindow.channelAvailable ? (
                  <p role="alert" className="text-sm text-destructive">
                    This channel has no recorded numeric values in this recording; there is nothing to visualize.
                  </p>
                ) : (
                  <>
                    {rawWindow.totalRawRowCount < maxValues && (
                      <p className="hint">
                        Short recording: only {rawWindow.totalRawRowCount.toLocaleString()} of {maxValues.toLocaleString()} pixels
                        have a recorded row; the remaining pixels show the "no data" fill below.
                      </p>
                    )}
                    {labelRanges.status === "error" && (
                      <p role="alert" className="text-xs text-destructive">
                        Could not load saved label ranges for this recording: {labelRanges.message}
                      </p>
                    )}
                    <div className="flex flex-col gap-4 lg:flex-row">
                      <Card className="min-w-0 lg:flex-1">
                        <CardContent className="pt-6">
                          <RawImageCanvas
                            rawWindow={rawWindow}
                            normalizationMode={normalizationMode}
                            title="Grayscale"
                            colorMode="grayscale"
                            labelRangeOverlay={<RawImageLabelRangeRail ranges={visibleLabelRanges} />}
                          />
                        </CardContent>
                      </Card>
                      <Card className="min-w-0 lg:flex-1">
                        <CardContent className="pt-6">
                          <RawImageCanvas
                            rawWindow={rawWindow}
                            normalizationMode={normalizationMode}
                            title="Rainbow (false-colour)"
                            colorMode="rainbow"
                          />
                        </CardContent>
                      </Card>
                      <Card className="min-w-0 lg:flex-1">
                        <CardContent className="pt-6">
                          {derivativeStatus === "loading" ? (
                            <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
                              <Skeleton className="h-80 w-80" />
                              <span className="sr-only">Loading derivative view…</span>
                            </div>
                          ) : derivativeStatus === "error" ? (
                            <div className="flex flex-col gap-2">
                              <h4 className="text-sm font-medium">Derivative (Savitzky–Golay)</h4>
                              <p role="alert" className="text-sm text-destructive">
                                Could not load the derivative view: {derivativeErrorMessage}
                              </p>
                            </div>
                          ) : derivativeWindow === null ? (
                            <div className="flex flex-col gap-2">
                              <h4 className="text-sm font-medium">Derivative (Savitzky–Golay)</h4>
                              <p className="hint">Derivative view not available yet.</p>
                            </div>
                          ) : !derivativeWindow.available ? (
                            <div className="flex flex-col gap-2">
                              <h4 className="text-sm font-medium">Derivative (Savitzky–Golay)</h4>
                              <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                                Derivative unavailable for this recording:{" "}
                                {derivativeWindow.unavailableReason ??
                                  "this recording's timestamp cadence does not meet the offline derivative's regularity requirement."}
                              </p>
                              {derivativeWindow.unavailableIsCadenceIssue &&
                                sampleOrderPreviewStatus !== "loaded" &&
                                sampleOrderPreviewStatus !== "loading" && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => rawImageViewerStore.requestSampleOrderPreview()}
                                  >
                                    Preview by sample order
                                  </Button>
                                )}
                              {sampleOrderPreviewStatus === "loading" ? (
                                <p className="text-sm text-muted-foreground" aria-live="polite">
                                  Loading sample-order preview…
                                </p>
                              ) : sampleOrderPreviewStatus === "error" ? (
                                <p role="alert" className="text-sm text-destructive">
                                  Could not load the sample-order preview: {sampleOrderPreviewErrorMessage}
                                </p>
                              ) : sampleOrderPreviewWindow === null ? null : !sampleOrderPreviewWindow.available ? (
                                <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                                  Sample-order preview also unavailable:{" "}
                                  {sampleOrderPreviewWindow.unavailableReason}
                                </p>
                              ) : (
                                <div className="flex flex-col gap-2">
                                  <p role="status" className="text-sm text-muted-foreground">
                                    Legacy visual preview — change per sample, not per second. This recording&apos;s
                                    saved timestamps remain timing-invalid; this view does not fix that and is never
                                    used for model training, export, or inference.
                                  </p>
                                  <RawImageCanvas
                                    rawWindow={rawWindow}
                                    normalizationMode={normalizationMode}
                                    title="Derivative preview (sample order, legacy)"
                                    colorMode="diverging"
                                    derivativeWindow={sampleOrderPreviewWindow}
                                    labelRangeOverlay={<RawImageLabelRangeRail ranges={visibleLabelRanges} />}
                                  />
                                </div>
                              )}
                            </div>
                          ) : (
                            <RawImageCanvas
                              rawWindow={rawWindow}
                              normalizationMode={normalizationMode}
                              title="Derivative (Savitzky–Golay)"
                              colorMode="diverging"
                              derivativeWindow={derivativeWindow}
                              labelRangeOverlay={<RawImageLabelRangeRail ranges={visibleLabelRanges} />}
                              titleHelp={
                                <HelpTooltip label="About the derivative view">
                                  An offline Savitzky–Golay first derivative of this saved recording&apos;s selected
                                  channel — a signed rate of change over time, computed fresh from the saved raw
                                  data on every load. It is not a live signal, is never used for training or
                                  inference, and is never written back into the recording. The Grayscale and
                                  Rainbow raw views, live telemetry, and Watch behavior are unchanged.
                                </HelpTooltip>
                              }
                            />
                          )}
                        </CardContent>
                      </Card>
                    </div>
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                          Rows {rawWindow.startRawRow.toLocaleString()}–{Math.max(rawWindow.startRawRow, rawWindow.endRawRow - 1).toLocaleString()} of{" "}
                          {rawWindow.totalRawRowCount.toLocaleString()}
                        </span>
                        <span>
                          Frame {currentFrame}
                          {totalFrames !== null ? ` of ${totalFrames}` : ""}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={bounds === null || requestedStartRawRow <= bounds.minStartRawRow}
                          onClick={() => rawImageViewerStore.goToPreviousFrame()}
                        >
                          Previous {rowHop} rows
                        </Button>
                        <Slider
                          aria-label="Raw row frame position"
                          min={bounds?.minStartRawRow ?? 0}
                          max={Math.max(bounds?.maxStartRawRow ?? 0, bounds?.minStartRawRow ?? 0)}
                          step={rowHop}
                          value={[requestedStartRawRow]}
                          disabled={bounds === null || bounds.maxStartRawRow === bounds.minStartRawRow}
                          onValueChange={(value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            if (typeof next === "number") rawImageViewerStore.setStartRawRow(next);
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={bounds === null || requestedStartRawRow >= bounds.maxStartRawRow}
                          onClick={() => rawImageViewerStore.goToNextFrame()}
                        >
                          Next {rowHop} rows
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : status === "loading" ? (
              <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
                <Skeleton className="h-80 w-80" />
                <span className="sr-only">Loading raw recording window…</span>
              </div>
            ) : status === "error" ? (
              <p role="alert" className="text-sm text-destructive">
                Could not load this raw window: {errorMessage}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
