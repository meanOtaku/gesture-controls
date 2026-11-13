# What kind of miss is each pinch not caught?

The new `pinch_in` model at its own cut-off (0.99) over the 11 recordings it never trained on: 120 pinches.
A pinch is caught when the model fires 300 to 900 ms after its labelled start. See `misses.py`.

| what happened | pinches | share |
|---|---:|---:|
| caught in its window | 95 | 79% |
| fired late: the action happens, after the window | 6 | 5% |
| fired early: before the window | 8 | 7% |
| silent: nothing fired during the pinch | 11 | 9% |

Late firings, ms after the labelled start: 2816, 2850, 3317, 3737, 4404, 5867.

Silent pinches' highest score in the 2 s after the start: 0.00, 0.09, 0.39, 0.73, 0.77, 0.80, 0.86, 0.97, 0.98, 0.99, 1.00.
4 of 11 reached 0.9; 3 stayed under 0.5.

Wrist turning in the 2 s before the start (gyroscope RMS, rad/s; median and most): caught 0.02 (most 0.83), late 1.35 (most 2.43), silent 0.03 (most 3.00).

| recording | caught | late | early | silent |
|---|---:|---:|---:|---:|
| pinch_hold-2026-11-03T01-08-34.844Z | 16 | 0 | 1 | 1 |
| pinch_hold-2026-11-04T04-50-33.518Z | 18 | 1 | 2 | 0 |
| pinch_hold-2026-11-06T08-10-50.079Z | 14 | 0 | 0 | 4 |
| pinch_hold-2026-11-09T13-48-35.709Z | 15 | 2 | 0 | 4 |
| pinch_hold-2026-11-09T13-51-14.408Z | 15 | 2 | 3 | 1 |
| pinch_hold-2026-11-09T13-54-14.793Z | 17 | 1 | 2 | 1 |
