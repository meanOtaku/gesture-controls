# Camera hand landmarks

The Recorder can save the landmarks of your hand with each recording, so gestures can later be labelled from what the camera saw instead of by hand. This document is the contract for what is saved and why it can be trusted. It covers capture only; turning landmarks into labels is a later step.

## What runs where

MediaPipe's Hand Landmarker runs **in the app's own web view**, on this computer, with no Python and no network: the model (`public/mediapipe/hand_landmarker.task`) and the WebAssembly runtime are served from the app's own files. It finds 21 landmarks per hand in each picture (image coordinates, and metric "world" coordinates centred on the hand) and says which hand it is.

The camera belongs to the app (`cameraService.ts`), not to a page, so a recording keeps getting pictures when you look at another tab. Frames are processed one at a time as the browser delivers them; the graphics path is tried first (about 12 ms a frame) with the CPU as a fallback (about 33 ms).

## Privacy

Only landmarks are saved, never the picture, and nothing leaves the computer. MediaPipe's runtime tries to send usage logs to `odml.pa.googleapis.com`; the app's content security policy (`connect-src 'self' ipc: ...`) does not allow it, and that must stay true. macOS asks for camera permission through the embedded `Info.plist` (`NSCameraUsageDescription`).

## Saved with the recording

Two optional files in the recording bundle, written once with the bundle and never rewritten, like `raw.csv`. The desktop checks each one (known name, size limit, exact header, every row's field count); the bundle's `recording.json` lists a source `camera_hand_landmarks` (not counted in `raw_source_row_counts`, since it adds no raw rows).

- `hand_landmarks.csv`: one row per hand per camera frame: `frame_index, capture_ms, hand_index, hand_count, model_handedness, score`, then `ix0..iz20` (image x, y, z for the 21 landmarks) and `wx0..wz20` (world). A frame with no hand is one row with the hand fields empty, so "the camera saw nothing" is recorded, not a gap. `capture_ms` is the browser's monotonic clock (`performance.now()`), the same clock `recording.json` uses.
- `clock_sync.csv`: pairs of a watch timestamp and the browser time it arrived, about every 200 ms, from which the camera is lined up with the watch.

`model_handedness` is MediaPipe's label, which assumes a mirrored picture; a webcam's raw picture is not mirrored, so the physical hand is the opposite. `physicalHand()` does the swap, and `recording.json` records the convention.

## Lining the camera up with the watch

Watch samples carry the watch's own clock. For each one the browser records when it arrived. `arrival - watch time` is the offset between the clocks plus the delivery delay, and the delay is never negative, so the smallest recent value is the best offset estimate (the fastest sample), and the spread above it is the link's jitter (`ClockSync`). The raw pairs are saved so the alignment can be redone better later. The estimate is shown in the Recorder. What remains uncertain is the camera's own pipeline delay (tens of milliseconds); WebKit supplied a capture time for the frames in the test below, and the source records how many frames had one. A calibration movement to measure that delay is not built yet.

## Limits

- At most 30,000 frames (about 17 minutes at 30 frames a second) are kept for one recording; beyond that the recording says it was cut short.
- 3 seconds of pre-roll and 1 second of margin either side of the recording are saved, so labels near the ends have a picture.
- The hand that wears the watch must be in view. Frames without a hand are recorded as such.

## How it was checked

Unit tests cover the controller (permissions, model failure, strictly increasing timestamps, pre-roll, windowing, the limit, discard), the CSV format on both sides, the clock estimator, the landmark measures and the bundle checks. The real MediaPipe pipeline was run in WebKit (the engine the desktop app uses) with the hand model, the GPU and CPU delegates, a camera-like video stream, and the exact production content security policy: about 23 frames a second, two hands with 21 landmarks each, every row with the right number of fields. **Not yet checked: a real webcam inside the Tauri window** (the macOS permission prompt, the camera's own capture times, and the frame rate on your hardware).
