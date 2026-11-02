# Old pinch recordings without camera data, split from the watch's motion

Made by `scripts/split_pinch_from_motion.py` from `data/recordings/old/` (unchanged). Each `pinch` label is
`pinch_in` (0.3 s from the touch), `pinch_hold` (to the release) and `pinch_out` (0.3 s from the release), placed
from the recording's own motion (see the script). A label that cannot say when the fingers parted gives no release:
the 3 s after its touch are `left_out`. Other labels are kept. These are estimates: prefer the camera-split recordings
(`../pinch-relabelled/`) where both exist.

Learned on 14 camera-split recordings: the touch comes -60 ms from the averaged jolt, the release -145 ms.

Tried on each camera-split recording with the gaps learned from the others:

| | Within 100 ms of the camera | Within 200 ms | Within 300 ms |
|---|---:|---:|---:|
| Touch (278) | 74% | 93% | 94% |
| Release (275) | 60% | 77% | 79% |

| Recording | Pinches | With a release | Jolt from label start | Jolt clarity |
|---|---:|---:|---:|---:|
| 2026-10-downloads/gesture-dataset-pinch-2026-10-04T11-43-31.691Z.csv | 24 | 22 | +140 ms | 1.7x |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-11T02-54-10.616Z.csv | 7 | 6 | -40 ms | 1.7x |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-11T03-23-55.502Z.csv | 9 | 9 | +60 ms | 2.1x |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-11T03-25-53.983Z.csv | 10 | 4 | +0 ms | 2.5x |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-11T08-25-29.427Z.csv | 12 | 12 | +160 ms | 2.5x |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-11T08-35-42.008Z.csv | 17 | 13 | -120 ms | 2.7x |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-11T08-53-30.484Z.csv | 29 | 24 | -800 ms | 1.9x |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-11T12-05-39.593Z.csv | 18 | 15 | -780 ms | 2.0x |
| 2026-10-downloads/gesture-dataset-pinch-2026-10-11T12-08-32.241Z.csv | 20 | 19 | +100 ms | 3.0x |
| 31oct/gesture-dataset-pinch-2026-10-31T07-19-58.709Z | 20 | 0 | +500 ms | 20.6x |
| 31oct/gesture-dataset-pinch-2026-10-31T07-25-53.089Z | 20 | 0 | +280 ms | 10.9x |

Total: 186 pinches split.

Not split:

- 2026-10-downloads/gesture-dataset-pinch-2026-09-22T13-39-36.998Z.csv: 33% of its motion rows repeat a sample under 1 ms later, so its timing cannot be used
