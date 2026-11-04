# Old pinch recordings, relabelled from the camera

Made by `scripts/relabel_pinch_from_camera.py` from `data/recordings/old/` (unchanged) and the camera landmarks saved
with each recording. Each labelled `pinch` the camera saw is `pinch_in` (0.3 s from the touch), `pinch_hold` (to the
release) and `pinch_out` (0.3 s from the release); one it saw no touch in is `left_out`. Other labels are kept.

| Recording | Pinches | Relabelled | Left out |
|---|---:|---:|---:|
| 2026-10-downloads/gesture-dataset-pinch-2026-10-14T00-54-06.988Z.csv | 25 | 24 | 1 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-14T00-55-38.245Z.csv | 25 | 25 | 0 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-14T00-57-01.701Z.csv | 22 | 22 | 0 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-14T00-58-20.761Z.csv | 26 | 26 | 0 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-14T00-59-37.623Z.csv | 18 | 18 | 0 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-14T01-00-54.801Z.csv | 24 | 24 | 0 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-14T01-04-14.013Z.csv | 29 | 29 | 0 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-14T01-05-31.133Z.csv | 28 | 28 | 0 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-14T01-13-08.108Z.csv | 28 | 27 | 1 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-17T12-21-44.346Z | 15 | 15 | 0 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-17T12-23-03.399Z.csv | 15 | 15 | 0 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-17T12-25-10.832Z.csv | 13 | 11 | 2 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-17T12-26-46.748Z.csv | 20 | 20 | 0 |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-17T12-40-50.602Z | 10 | 6 | 4 |

Total: 290 of 298 pinches relabelled.

Not relabelled (no camera data, so their timing cannot be recovered):

- 2026-10-downloads/gesture-dataset-pinch-2026-09-22T13-39-36.998Z.csv: no camera recording saved with it
- 2026-10-downloads/gesture-dataset-pinch-2026-10-04T11-43-31.691Z.csv: no camera recording saved with it
- 2026-10-downloads/gesture-dataset-pinch-2026-10-11T02-54-10.616Z.csv: no camera recording saved with it
- 2026-10-downloads/gesture-dataset-pinch-2026-10-11T03-23-55.502Z.csv: no camera recording saved with it
- 2026-10-downloads/gesture-dataset-pinch-2026-10-11T03-25-53.983Z.csv: no camera recording saved with it
- 2026-10-downloads/gesture-dataset-pinch-2026-10-11T08-25-29.427Z.csv: no camera recording saved with it
- 2026-10-downloads/gesture-dataset-pinch-2026-10-11T08-35-42.008Z.csv: no camera recording saved with it
- 2026-10-downloads/gesture-dataset-pinch-2026-10-11T08-53-30.484Z.csv: no camera recording saved with it
- 2026-10-downloads/gesture-dataset-pinch-2026-10-11T12-05-39.593Z.csv: no camera recording saved with it
- 2026-10-downloads/gesture-dataset-pinch-2026-10-11T12-08-32.241Z.csv: no camera recording saved with it
- 31oct/gesture-dataset-pinch-2026-10-31T07-19-58.709Z: no camera recording saved with it
- 31oct/gesture-dataset-pinch-2026-10-31T07-25-53.089Z: no camera recording saved with it
