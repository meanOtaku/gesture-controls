# Pinch in / out sessions with the camera, 3 Nov 2026

Five sessions exported from the Recorder as folders, with the camera on and hand landmarks saved. Each pinch was marked
by the camera: `pinch_in` (0.3 s from where the thumb and index met), `pinch_hold` (to where they parted) and
`pinch_out` (0.3 s from there). Wrist left, arm resting, light pinch, normal strap.

Each folder holds the two watch files (`ppg.csv`, `imu.csv`) and the camera's files: `hand_landmarks.csv` (with each
frame's watch time as its first column) and `clock_sync.csv`. Opened with **Open folder…** on the Labelling page, the
hand is drawn at the cursor; imported into Model Lab, the camera files are kept.

| Folder (UTC) | Model Lab | Pinches cued | Marked by the camera |
|---|---|---:|---:|
| gesture-dataset-pinch_in-2026-11-03T01-08-16.560Z | #30 | 20 | 20 |
| gesture-dataset-pinch_in-2026-11-03T01-10-50.957Z | #31 | 20 | 20 |
| gesture-dataset-pinch_in-2026-11-03T01-13-19.283Z | #32 | 20 | 21 |
| gesture-dataset-pinch_in-2026-11-03T01-17-14.928Z | #33 | 20 | 21 |
| gesture-dataset-pinch_in-2026-11-03T12-40-05.547Z | not added | – | 20 (2 min 12 s) |
| gesture-dataset-pinch_in-2026-11-04T04-46-55.110Z | – | 20 | 20 |
| gesture-dataset-pinch_in-2026-11-04T04-49-21.416Z | – | 20 | 20 |
| gesture-dataset-pinch_in-2026-11-04T04-53-02.645Z | – | 20 | 22 |

The marks in these folders come from `scripts/mark_pinches_from_camera.py`, which judges each session against its own hand
(the rule is in `edges` in `scripts/relabel_pinch_from_camera.py`). The app's original marks used one fixed level, 0.35 hand
sizes, and missed whole stretches of the 01:17 and 12:40 sessions, whose fingers never looked closer than that. Marks beyond
the cued count are brief real finger closes.

Model Lab's #30–33 were added from the same sessions' Recorder recordings, not from these folders. The 12:40 session is not in Model Lab yet.
