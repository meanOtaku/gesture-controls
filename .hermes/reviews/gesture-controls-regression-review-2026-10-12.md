# Gesture Controls regression review — 2026-10-12

## Scope

Deep static and automated review of changes from the previously checked-out `cbe5b22` through `main` after the PPG rollback at `ba5691b`.

The three final rollback commits intentionally restore the previously working PPG path:

- `01089e3` removes the combined-message setting.
- `27998dd` restores separate `watch.orientation` and `watch.ppg_batch` transport.
- `ba5691b` restores the proven 1 Hz `PPG_CONTINUOUS` flush default while retaining connection retry handling.

No additional direct PPG tracker-connection regression was found after those rollbacks. The wider change range contains the following additional behavioral regressions.

## Findings

### P1 — high priority

1. **Camera marking stops when Recorder unmounts**
   - Location: `apps/desktop/src/features/gestureLibrary/CameraAssistCard.tsx:44`
   - Trigger: start camera-assisted recording, then navigate away from Recorder.
   - Impact: recording and evidence collection continue, but the page-owned marking hook disappears. Later gestures are unmarked and an open mark can extend until recording stops.
   - Missing coverage: navigation tests do not enable camera marking or inspect resulting annotations.

2. **Legacy dataset conversion changes model inputs while preserving the old identity**
   - Locations: `apps/desktop/src-tauri/src/dataset_files.rs:332`, `tools/label-trainer/src/label_trainer/csv_io.py:147`
   - Trigger: convert a legacy CSV row containing both PPG and IMU values to separate dense files.
   - Impact: one fused observation becomes two observations; carry-forward processing changes statistics and orientation deltas, but conversion retains the legacy identity/hash. Existing models can therefore be evaluated against behaviorally different data presented as the same dataset.
   - Missing coverage: conversion tests count split rows but do not compare downstream extracted features for fused rows.

### P2 — camera and recording

3. **Overlapping camera startup can permanently stop frame scheduling**
   - Location: `apps/desktop/src/features/camera/cameraController.ts:237-249`
   - A stale generation can set `framePending`; its callback exits on generation mismatch without clearing it, preventing the replacement generation from scheduling frames.

4. **Changing the selected label during recording can mark one gesture as another**
   - Location: `apps/desktop/src/features/gestureLibrary/CameraAssistCard.tsx:34-44`
   - Detection definitions follow `selectedLabel`, while the recording remains armed for the original label.

5. **Closing Quick Preview can blank an already-mounted Recorder preview**
   - Location: `apps/desktop/src/features/camera/components/CameraPreview.tsx:15-24`
   - Both preview owners move the same video element; cleanup parks it instead of restoring the surviving owner.

6. **Camera labels include release grace and inference latency**
   - Location: `apps/desktop/src/features/gestureLibrary/useCameraMarking.ts:9-14`
   - Start uses the detector's backdated onset, but release closes at the current row rather than the detector's actual release timestamp.

7. **Delayed samples invalidate stored camera-onset row positions**
   - Location: `apps/desktop/src/features/telemetry/store/telemetryStore.ts:636`
   - Chronological insertion reindexes intervals but not the arrival-trail row references used to resolve camera onset, shifting saved annotation boundaries.

8. **Secondary-camera-only evidence is treated as absent**
   - Location: `apps/desktop/src-tauri/src/recording_bundle.rs:2660-2663`
   - `get_recording_camera_evidence` returns `None` when `hand_landmarks.csv` is absent before checking valid `hand_landmarks_2.csv` evidence.

### P2 — dataset and model lifecycle

9. **Converted recordings bypass duplicate protection**
   - Location: `apps/desktop/src-tauri/src/model_lab.rs:461-468`
   - A converted folder's preserved legacy hash is compared with the incoming pair hash; equal content can be imported twice and enter different data partitions.

10. **Converted paths break training-range backfill**
    - Location: `apps/desktop/src-tauri/src/range_backfill.rs:198-205`
    - Hash validation resolves the replacement folder, but the trainer receives the old saved spec that still names the deleted `.csv` path.

11. **Interrupted conversion is not safely retryable**
    - Location: `apps/desktop/src-tauri/src/model_lab.rs:666-718`
    - If folder creation succeeds but index persistence fails, the index still says legacy while retry encounters an existing non-empty target directory.

12. **Correction-trained models reject standalone hand edits**
    - Location: `apps/desktop/src-tauri/src/label_training.rs:954-969`
    - Existing `train_only` entries require a new fine-tune plan even when no new extra recording is being added.

13. **Timing-check results can be applied to changed training inputs**
    - Location: `apps/desktop/src/features/model-lab/components/LabelTiming.tsx:44-57`
    - Results and pending responses are not tied to request identity, so changing target, recordings, roles, or design can leave a stale recommendation active.

14. **A stale save response can erase edits to another model**
    - Location: `apps/desktop/src/features/model-lab/components/ModelInspector.tsx:110`
    - Completion for model A clears state after the user has selected and edited model B.

15. **Camera loss hides both Stop and Discard during a correction round**
    - Location: `apps/desktop/src/features/model-lab/components/CorrectionSession.tsx:235-248`
    - Readiness blockers gate the entire control group instead of only the action that starts a recording.

### P2 — training/live inference parity

16. **PPG baseline boundaries differ between training and live inference**
    - Locations: `tools/label-trainer/src/label_trainer/features.py:497-510`, `crates/label-inference/src/pipeline.rs:438-447`
    - Python anchors baseline history to the first sampled row; Rust anchors it to the requested window start. When the boundary falls between samples, percentile-based relative features differ.

17. **Loss of baseline history can leave a live detection held**
    - Location: `crates/label-inference/src/pipeline.rs:441-446`
    - Returning `Ok(None)` after an established model loses its baseline does not clear the active detector state. A recovered stream can therefore leave a released gesture active.

18. **Dense-network construction can silently replace requested shapes**
    - Location: `tools/label-trainer/src/label_trainer/label_train.py:336-349`
    - Legacy `params.hidden` can be shadowed by parsed defaults, and an explicitly accepted empty hidden-layer list falls back to `(32, 16)` while provenance says no hidden layers.

## Verification evidence

Passed:

- Frontend test suite (`npm test`).
- Frontend TypeScript project check (`npm run typecheck`).
- Frontend production build (`npm run build`).
- Python trainer suite: 173 passed, 44 skipped.
- Wear OS JVM tests and debug APK assembly.
- Targeted Rust suites for `model-lab-core`, `pinch-inference`, `label-inference`, `spatial-protocol`, and `watch-bridge`.
- `git diff --check` for the reviewed range.

Blocked or unavailable:

- Full Rust workspace clippy/test could not start on this host because `pkg-config` and GLib development packages are absent. This is an environment blocker, not evidence that the remaining workspace passes.
- Physical Galaxy Watch PPG verification was not possible because no ADB device was connected.

## Recommended repair order

1. Fix the two P1 issues and add fused-row feature-equivalence coverage.
2. Fix training/live baseline parity and clear detector state when baseline becomes unavailable.
3. Make conversion transactional/retryable and repair duplicate/backfill handling.
4. Move camera marking into recording-owned lifecycle and fix stable timestamp/row resolution.
5. Fix camera ownership/startup races and secondary-only evidence.
6. Add request-identity guards to Model Lab async operations and preserve stop/discard controls during failures.
7. Correct dense-network shape precedence with explicit legacy and empty-shape tests.

## Delivery state

This document records review findings only. Apart from the three already-pushed PPG rollback commits, these findings have not been repaired or pushed.

## Repairs

All 18 findings are repaired on `fix/review-regressions`, each with a test that fails without the fix:

| Findings | Commit | What changed |
|---|---|---|
| 1, 4, 6, 7 | `b7d1e56` | Camera marking is owned by the recording (`startCameraMarking`), not a page; gestures fixed at start; marks close at the detector's release time; camera onset/release rows found by timestamp, not a stale index. |
| 2, 9, 10, 11 | `e7b9843` | A converted fused row is read back as one row (features match the original exactly); duplicate check compares contents; backfill gets current paths; an interrupted conversion can be retried. |
| 16, 17 | `3f55f75` | Live baseline anchored on the window's first sample, as training; a lost baseline is reported once (`BaselineUnavailable`), releasing the detection. |
| 3, 5, 8 | `6715c93` | Frame request per camera generation, checked after every await; previews hand the video back to the newest one open; second-camera-only evidence counts. |
| 13, 14, 15 | `404f1b9` | Timing results tied to the request they answer; a save leaves another model's edits alone; Stop and Discard stay available mid-round. |
| 12 | `0d0ad47` | Hand edits allowed on models trained with correction recordings. |
| 18 | `641ef8d` | Dense networks get exactly the requested shape (legacy `params.hidden` honoured, empty list kept empty). |