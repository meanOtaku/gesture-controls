# Camera-label hold-gap audit, November 2026

**Status:** review queue only. No labels, raw recordings, training cohort, model, or threshold were changed.

## Finding

The latest camera-timed pinch figure exposed events where a `pinch_in` label is followed immediately by `pinch_out`, with no intervening `pinch_hold` interval. The optical response can remain large after the camera-derived release boundary, so a PPG spike alone cannot be used to move the boundary. These are candidates for visual review in the application Labelling page.

The displayed event in `gesture-dataset-pinch_in-2026-11-04T04-53-02.645Z` is:

| Label | Watch-clock seconds from recording start |
|---|---:|
| `pinch_in` | 37.000–37.302 |
| `pinch_out` | 37.302–37.615 |

There is no `pinch_hold` row between them. The orange highlight is therefore present but short; the longer PPG excursion is not, by itself, a release-ground-truth signal.

## Scope

A read-only scan of every `gesture-dataset-pinch*/ppg.csv` folder under `data/recordings/new/` found **163** camera-labelled `pinch_in` intervals. **Eight** are immediately followed by `pinch_out` and have no `pinch_hold`:

| Recording | `pinch_in` (s) | immediate `pinch_out` (s) |
|---|---:|---:|
| `gesture-dataset-pinch_in-2026-11-03T01-17-14.928Z` | 2.434–2.719 | 2.719–3.020 |
| same recording | 30.564–30.886 | 30.886–31.181 |
| `gesture-dataset-pinch_in-2026-11-03T12-40-05.547Z` | 5.436–5.516 | 5.516–5.825 |
| same recording | 66.563–66.637 | 66.637–66.945 |
| same recording | 79.205–79.309 | 79.309–79.579 |
| `gesture-dataset-pinch_in-2026-11-04T04-49-21.416Z` | 40.370–40.410 | 40.410–40.715 |
| `gesture-dataset-pinch_in-2026-11-04T04-53-02.645Z` | 37.000–37.302 | 37.302–37.615 |
| same recording | 67.157–67.223 | 67.223–67.510 |

## Review procedure

1. In the desktop application, open the exported recording with **Labelling → Open folder…** so the saved `hand_landmarks.csv` and `clock_sync.csv` are available alongside PPG and IMU.
2. Navigate to the listed watch-clock interval and inspect the hand landmarks around the closure and release.
3. Adjust only the label boundaries supported by the landmark evidence. Do not infer a release time solely from the delayed/prolonged PPG peak.
4. Save the reviewed label version through the application. Raw PPG, IMU, landmarks, and clock-sync rows must remain unchanged.
5. Record the corrected intervals and reviewer decision before retraining. Keep corrected sessions separate from the current frozen curriculum evidence until a new cohort and independent test are defined.

## Interpretation and next step

Immediate `pinch_in` → `pinch_out` can represent a genuine rapid release, an ambiguous/short landmark sequence, or a timing/marking deficiency. This audit does not decide which applies to any event. After review, rerun the label scan and compare the amended timing against the original version before changing the CNN dataset or reporting new results.
