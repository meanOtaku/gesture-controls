# Multi-gesture CNN with snap: before and after the tighter snap labels

Replayed over the same held-out recordings, current hand labels. See `compare.py`.

## At each model's own cut-off

| gesture | before cut-off | before caught | before false/h | before latency | after cut-off | after caught | after false/h | after latency |
|---|---|---|---|---|---|---|---|---|
| pinch_in | 0.98 | 74/89 | 5.4 | 432 ms | 0.97 | 71/89 | 0.0 | 414 ms |
| pinch_hold | 0.9 | 59/79 | 16.2 | 493 ms | 0.85 | 63/79 | 18.0 | 498 ms |
| pinch_out | 0.85 | 86/87 | 16.5 | 486 ms | 0.9 | 86/87 | 16.5 | 459 ms |
| snap_fingers | 0.85 | 21/38 | 12.6 | 369 ms | 0.85 | 31/38 | 7.2 | 594 ms |

## pinch_in, by threshold

| threshold | before caught | before false/h | after caught | after false/h |
|---|---|---|---|---|
| 0.999 | 65/89 | 1.8 | 63/89 | 0.0 |
| 0.995 | 70/89 | 3.6 | 68/89 | 0.0 |
| 0.99 | 72/89 | 3.6 | 69/89 | 0.0 |
| 0.98 | 74/89 | 5.4 | 71/89 | 0.0 |
| 0.95 | 75/89 | 9.0 | 71/89 | 1.8 |
| 0.9 | 76/89 | 9.0 | 73/89 | 3.6 |
| 0.85 | 78/89 | 12.6 | 74/89 | 5.4 |
| 0.8 | 79/89 | 12.6 | 75/89 | 5.4 |
| 0.7 | 79/89 | 18.1 | 74/89 | 7.2 |
| 0.6 | 80/89 | 21.7 | 75/89 | 12.6 |
| 0.5 | 80/89 | 23.5 | 75/89 | 18.1 |

## pinch_hold, by threshold

| threshold | before caught | before false/h | after caught | after false/h |
|---|---|---|---|---|
| 0.999 | 51/79 | 1.8 | 46/79 | 9.0 |
| 0.995 | 55/79 | 10.8 | 56/79 | 10.8 |
| 0.99 | 55/79 | 12.6 | 57/79 | 12.6 |
| 0.98 | 57/79 | 12.6 | 59/79 | 12.6 |
| 0.95 | 58/79 | 16.2 | 60/79 | 12.6 |
| 0.9 | 59/79 | 16.2 | 62/79 | 14.4 |
| 0.85 | 60/79 | 21.6 | 63/79 | 18.0 |
| 0.8 | 60/79 | 25.2 | 63/79 | 18.0 |
| 0.7 | 61/79 | 30.6 | 63/79 | 34.2 |
| 0.6 | 61/79 | 34.2 | 64/79 | 41.4 |
| 0.5 | 61/79 | 43.2 | 64/79 | 50.4 |

## pinch_out, by threshold

| threshold | before caught | before false/h | after caught | after false/h |
|---|---|---|---|---|
| 0.999 | 80/87 | 0.0 | 78/87 | 1.8 |
| 0.995 | 83/87 | 5.5 | 82/87 | 5.5 |
| 0.99 | 83/87 | 5.5 | 83/87 | 5.5 |
| 0.98 | 83/87 | 9.2 | 85/87 | 5.5 |
| 0.95 | 83/87 | 11.0 | 85/87 | 11.0 |
| 0.9 | 84/87 | 12.8 | 86/87 | 16.5 |
| 0.85 | 86/87 | 16.5 | 86/87 | 20.2 |
| 0.8 | 86/87 | 18.3 | 86/87 | 22.0 |
| 0.7 | 86/87 | 25.7 | 86/87 | 29.4 |
| 0.6 | 86/87 | 45.9 | 86/87 | 36.7 |
| 0.5 | 86/87 | 49.5 | 85/87 | 45.9 |

## snap_fingers, by threshold

| threshold | before caught | before false/h | after caught | after false/h |
|---|---|---|---|---|
| 0.999 | 10/38 | 0.0 | 19/38 | 0.0 |
| 0.995 | 17/38 | 0.0 | 20/38 | 0.0 |
| 0.99 | 18/38 | 0.0 | 22/38 | 0.0 |
| 0.98 | 18/38 | 3.6 | 25/38 | 0.0 |
| 0.95 | 19/38 | 3.6 | 26/38 | 1.8 |
| 0.9 | 20/38 | 7.2 | 29/38 | 3.6 |
| 0.85 | 21/38 | 12.6 | 31/38 | 7.2 |
| 0.8 | 20/38 | 21.6 | 31/38 | 7.2 |
| 0.7 | 20/38 | 30.6 | 31/38 | 7.2 |
| 0.6 | 21/38 | 34.2 | 35/38 | 12.6 |
| 0.5 | 17/38 | 55.9 | 36/38 | 16.2 |

## Event confusion, before

```
{
 "gestures": [
  "pinch_in",
  "pinch_hold",
  "pinch_out",
  "snap_fingers"
 ],
 "rows": [
  {
   "gesture": "pinch_in",
   "starts": 89,
   "caughtBy": {
    "pinch_in": 74,
    "pinch_hold": 0,
    "pinch_out": 0,
    "snap_fingers": 5
   },
   "missed": 13
  },
  {
   "gesture": "pinch_hold",
   "starts": 79,
   "caughtBy": {
    "pinch_in": 1,
    "pinch_hold": 59,
    "pinch_out": 1,
    "snap_fingers": 0
   },
   "missed": 19
  },
  {
   "gesture": "pinch_out",
   "starts": 87,
   "caughtBy": {
    "pinch_in": 0,
    "pinch_hold": 1,
    "pinch_out": 86,
    "snap_fingers": 0
   },
   "missed": 1
  },
  {
   "gesture": "snap_fingers",
   "starts": 38,
   "caughtBy": {
    "pinch_in": 4,
    "pinch_hold": 0,
    "pinch_out": 0,
    "snap_fingers": 21
   },
   "missed": 13
  }
 ],
 "noGesture": {
  "falseActivations": {
   "pinch_in": 3,
   "pinch_hold": 9,
   "pinch_out": 9,
   "snap_fingers": 7
  },
  "hours": {
   "pinch_in": 0.5539989503088889,
   "pinch_hold": 0.5551070943311112,
   "pinch_out": 0.5451217995519444,
   "snap_fingers": 0.555027755435
  },
  "falseActivationsPerHour": {
   "pinch_in": 5.415172715268347,
   "pinch_hold": 16.213087694086767,
   "pinch_out": 16.510071707639337,
   "snap_fingers": 12.611981890011586
  }
 }
}
```

## Event confusion, after

```
{
 "gestures": [
  "pinch_in",
  "pinch_hold",
  "pinch_out",
  "snap_fingers"
 ],
 "rows": [
  {
   "gesture": "pinch_in",
   "starts": 89,
   "caughtBy": {
    "pinch_in": 71,
    "pinch_hold": 0,
    "pinch_out": 0,
    "snap_fingers": 0
   },
   "missed": 18
  },
  {
   "gesture": "pinch_hold",
   "starts": 79,
   "caughtBy": {
    "pinch_in": 0,
    "pinch_hold": 63,
    "pinch_out": 0,
    "snap_fingers": 0
   },
   "missed": 16
  },
  {
   "gesture": "pinch_out",
   "starts": 87,
   "caughtBy": {
    "pinch_in": 0,
    "pinch_hold": 1,
    "pinch_out": 86,
    "snap_fingers": 0
   },
   "missed": 1
  },
  {
   "gesture": "snap_fingers",
   "starts": 38,
   "caughtBy": {
    "pinch_in": 18,
    "pinch_hold": 0,
    "pinch_out": 0,
    "snap_fingers": 31
   },
   "missed": 3
  }
 ],
 "noGesture": {
  "falseActivations": {
   "pinch_in": 0,
   "pinch_hold": 10,
   "pinch_out": 9,
   "snap_fingers": 4
  },
  "hours": {
   "pinch_in": 0.5539989503088889,
   "pinch_hold": 0.5551070943311112,
   "pinch_out": 0.5451217995519444,
   "snap_fingers": 0.555027755435
  },
  "falseActivationsPerHour": {
   "pinch_in": 0.0,
   "pinch_hold": 18.01454188231863,
   "pinch_out": 16.510071707639337,
   "snap_fingers": 7.206846794292335
  }
 }
}
```
