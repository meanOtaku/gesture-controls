# Does a pinch contact show as a jolt in the motion sensors?

21 recordings with camera hand tracking; 743 contacts, 738 releases, 816 random moments. Motion at 50 Hz, camera at 30 frames a second; the clocks line up to within 94 ms (median of the recordings' 90th-percentile spread; 78 to 131 ms).

## One moment at a time

ROC AUC of the largest jolt within 150 ms of the moment, against random moments (0.5 is chance).

| Sensor | Contact vs random | Release vs random |
|---|---:|---:|
| accelerometer | 0.769 | 0.762 |
| gyroscope | 0.729 | 0.730 |

## Averages

The jolt (in units of each recording's spread) averaged around each kind of moment: its peak within 0.3 s, how many
standard errors that stands above zero, and the share of recordings whose own average peaks clearly (two standard
deviations above its level 0.6-1 s away).

| Sensor | Moment | Peak at | Peak | Peak / SE | Recordings with a clear peak |
|---|---|---:|---:|---:|---:|
| accelerometer | contact | +0.14 s | +3.95 | 8.1 | 95% (21) |
| accelerometer | release | +0.10 s | +3.84 | 6.5 | 95% (21) |
| accelerometer | random | +0.30 s | +0.40 | 2.8 | 35% (20) |
| gyroscope | contact | +0.12 s | +4.70 | 8.5 | 95% (21) |
| gyroscope | release | +0.12 s | +5.78 | 4.8 | 90% (21) |
| gyroscope | random | +0.30 s | +0.86 | 3.4 | 35% (20) |
