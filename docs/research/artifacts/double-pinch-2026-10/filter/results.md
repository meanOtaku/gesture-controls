# Which high-pass filter separates a pinch from other motion?

277 camera-timed pinch contacts. Minutes: everything_else recordings 2.0, fist 6.8, wrist twist 0.7, rest (pinch sessions) 0.1, thumbs up 1.4, typing 1.0, mouse 0.8, arm movement 0.8.

## Where the energy lies

Mean power of the linear acceleration in each band, over 0.64 s windows (pinch: from 0.1 s before the contact). The last columns divide the pinch's power by each activity's: higher means the band favours the pinch.

| Window | 0-2 Hz | 2-5 Hz | 5-10 Hz | 10-15 Hz | 15-25 Hz |
|---|---:|---:|---:|---:|---:|
| pinch contacts | 6.7 | 8.59 | 8.84 | 7.02 | 5.05 |
| everything_else recordings | 18 | 11.7 | 6.18 | 2.6 | 1.09 |
| fist | 1.77 | 3.39 | 4.64 | 2.68 | 1.96 |
| wrist twist | 20.9 | 7.96 | 0.549 | 0.15 | 0.0161 |
| rest (pinch sessions) | 5.35 | 3.76 | 2.03 | 0.68 | 0.224 |
| thumbs up | 1.16 | 0.845 | 0.268 | 0.0553 | 0.0135 |
| typing | 10 | 24.7 | 16.1 | 4.1 | 2.66 |
| mouse | 10.3 | 24.1 | 10.9 | 3.34 | 1.51 |
| arm movement | 1.17e+03 | 1.37e+03 | 447 | 190 | 79.4 |

| Pinch ÷ | 0-2 Hz | 2-5 Hz | 5-10 Hz | 10-15 Hz | 15-25 Hz |
|---|---:|---:|---:|---:|---:|
| everything_else recordings | 0.37 | 0.73 | 1.43 | 2.70 | 4.62 |
| fist | 3.79 | 2.53 | 1.91 | 2.62 | 2.57 |
| wrist twist | 0.32 | 1.08 | 16.11 | 46.80 | 312.54 |
| rest (pinch sessions) | 1.25 | 2.28 | 4.35 | 10.32 | 22.52 |
| thumbs up | 5.78 | 10.17 | 33.04 | 126.78 | 373.12 |
| typing | 0.67 | 0.35 | 0.55 | 1.71 | 1.90 |
| mouse | 0.65 | 0.36 | 0.81 | 2.10 | 3.34 |
| arm movement | 0.01 | 0.01 | 0.02 | 0.04 | 0.06 |

## Filters on the accelerometer

Threshold keeps 95% of pinch peaks; cells are candidate peaks a minute (lower is better).

| Filter | Pinch peak | Over the floor | everything_else recordings | fist | wrist twist | rest (pinch sessions) | thumbs up | typing | mouse | arm movement | All activities |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| trailing 0.3 s mean subtracted | 0.813 | 5.90× | 53.4 | 31.4 | 39.7 | 40.5 | 10.9 | 90.0 | 72.0 | 76.0 | 42.1 |
| first difference | 0.83 | 7.09× | 48.4 | 24.8 | 15.6 | 30.3 | 2.9 | 88.0 | 72.0 | 80.0 | 36.0 |
| Butterworth order 2, 1 Hz | 0.802 | 6.01× | 49.9 | 30.0 | 38.3 | 50.6 | 9.5 | 90.0 | 68.0 | 80.0 | 40.8 |
| Butterworth order 2, 3 Hz | 0.66 | 6.71× | 44.9 | 27.7 | 21.3 | 30.3 | 6.5 | 90.0 | 66.7 | 77.3 | 37.3 |
| Butterworth order 2, 5 Hz | 0.61 | 6.97× | 44.4 | 26.5 | 17.0 | 40.5 | 5.1 | 90.0 | 69.3 | 80.0 | 36.6 |
| Butterworth order 2, 8 Hz | 0.525 | 7.37× | 46.4 | 25.5 | 4.3 | 20.2 | 2.9 | 89.0 | 73.3 | 77.3 | 35.4 |
| Butterworth order 2, 12 Hz | 0.376 | 7.31× | 44.4 | 23.6 | 2.8 | 20.2 | 0.7 | 93.0 | 69.3 | 77.3 | 33.9 |
| Butterworth order 2, 16 Hz | 0.251 | 7.16× | 46.4 | 23.9 | 0.0 | 10.1 | 0.7 | 85.0 | 64.0 | 81.3 | 33.5 |
| Butterworth order 4, 1 Hz | 0.768 | 5.67× | 51.9 | 28.9 | 39.7 | 40.5 | 9.5 | 91.0 | 70.7 | 76.0 | 40.5 |
| Butterworth order 4, 3 Hz | 0.671 | 6.07× | 44.4 | 27.1 | 19.8 | 30.3 | 5.1 | 85.0 | 70.7 | 73.3 | 36.3 |
| Butterworth order 4, 5 Hz | 0.614 | 6.48× | 47.9 | 25.2 | 11.3 | 40.5 | 4.4 | 86.0 | 76.0 | 74.7 | 35.9 |
| Butterworth order 4, 8 Hz | 0.485 | 6.56× | 47.9 | 24.0 | 2.8 | 30.3 | 1.5 | 89.0 | 74.7 | 81.3 | 35.0 |
| Butterworth order 4, 12 Hz | 0.353 | 6.82× | 47.9 | 24.0 | 1.4 | 20.2 | 0.7 | 89.0 | 69.3 | 77.3 | 34.3 |
| Butterworth order 4, 16 Hz | 0.214 | 6.38× | 55.4 | 27.0 | 0.0 | 10.1 | 0.0 | 90.0 | 72.0 | 82.7 | 37.2 |

## Filters on the gyroscope

Threshold keeps 95% of pinch peaks; cells are candidate peaks a minute (lower is better).

| Filter | Pinch peak | Over the floor | everything_else recordings | fist | wrist twist | rest (pinch sessions) | thumbs up | typing | mouse | arm movement | All activities |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| trailing 0.3 s mean subtracted | 0.276 | 5.88× | 65.8 | 37.9 | 44.0 | 70.8 | 12.4 | 89.0 | 69.3 | 77.3 | 47.7 |
| first difference | 0.24 | 9.13× | 61.4 | 24.9 | 36.9 | 60.7 | 6.5 | 90.0 | 61.3 | 80.0 | 39.2 |
| Butterworth order 2, 1 Hz | 0.278 | 6.10× | 63.4 | 35.7 | 52.5 | 60.7 | 12.4 | 88.0 | 76.0 | 85.3 | 47.4 |
| Butterworth order 2, 3 Hz | 0.243 | 8.35× | 62.4 | 27.0 | 35.4 | 60.7 | 8.7 | 84.0 | 64.0 | 85.3 | 40.6 |
| Butterworth order 2, 5 Hz | 0.193 | 8.73× | 59.4 | 25.6 | 35.4 | 70.8 | 8.0 | 89.0 | 60.0 | 74.7 | 39.0 |
| Butterworth order 2, 8 Hz | 0.133 | 8.75× | 63.4 | 25.2 | 32.6 | 70.8 | 5.8 | 92.0 | 57.3 | 82.7 | 39.5 |
| Butterworth order 2, 12 Hz | 0.0837 | 8.80× | 54.9 | 23.3 | 28.4 | 70.8 | 1.5 | 86.0 | 49.3 | 74.7 | 35.3 |
| Butterworth order 2, 16 Hz | 0.0479 | 9.63× | 54.4 | 23.1 | 19.8 | 70.8 | 0.7 | 85.0 | 45.3 | 77.3 | 34.5 |
| Butterworth order 4, 1 Hz | 0.276 | 4.79× | 69.8 | 37.1 | 63.8 | 50.6 | 15.3 | 85.0 | 76.0 | 85.3 | 49.6 |
| Butterworth order 4, 3 Hz | 0.232 | 7.43× | 62.4 | 26.4 | 31.2 | 50.6 | 7.3 | 83.0 | 60.0 | 77.3 | 39.1 |
| Butterworth order 4, 5 Hz | 0.176 | 7.75× | 61.9 | 25.3 | 34.0 | 70.8 | 6.5 | 85.0 | 61.3 | 81.3 | 39.2 |
| Butterworth order 4, 8 Hz | 0.118 | 7.25× | 58.4 | 23.7 | 22.7 | 60.7 | 2.2 | 87.0 | 49.3 | 76.0 | 35.9 |
| Butterworth order 4, 12 Hz | 0.0655 | 8.57× | 55.9 | 23.4 | 11.3 | 80.9 | 0.7 | 86.0 | 46.7 | 78.7 | 34.7 |
| Butterworth order 4, 16 Hz | 0.0335 | 9.01× | 56.9 | 24.3 | 9.9 | 60.7 | 0.0 | 85.0 | 49.3 | 78.7 | 35.1 |

1.5 s.
