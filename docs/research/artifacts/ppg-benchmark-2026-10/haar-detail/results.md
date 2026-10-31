# Does the Haar wavelet detail set a pinch apart?

ROC AUC: 0.5 is chance, 1.0 is perfect separation. Pulse colours are sampled at 25 Hz and the motion sensors at about
50 Hz, so a scale of n samples spans n/25 or n/50 seconds either side. The viewer's scale is 4.

## Pinch starts: the largest detail from 0.5 s before to 1.0 s after

| Channel | Scale 2: vs random | Scale 4: vs random | Scale 8: vs random | Scale 16: vs random | Best scale: median per recording | Best scale: vs other gestures |
|---|---:|---:|---:|---:|---:|---:|
| ppg_green | 0.526 | 0.511 | 0.488 | 0.486 | 0.510 (scale 2) | 0.411 |
| ppg_red | 0.506 | 0.494 | 0.461 | 0.443 | 0.588 (scale 2) | 0.381 |
| ppg_ir | 0.473 | 0.458 | 0.442 | 0.446 | 0.560 (scale 2) | 0.368 |
| accel_x | 0.478 | 0.455 | 0.448 | 0.487 | 0.533 (scale 16) | 0.386 |
| accel_y | 0.479 | 0.467 | 0.480 | 0.466 | 0.562 (scale 8) | 0.385 |
| accel_z | 0.454 | 0.466 | 0.478 | 0.477 | 0.550 (scale 8) | 0.338 |
| gyro_x | 0.530 | 0.543 | 0.512 | 0.473 | 0.473 (scale 4) | 0.436 |
| gyro_y | 0.464 | 0.474 | 0.511 | 0.480 | 0.659 (scale 8) | 0.360 |
| gyro_z | 0.476 | 0.455 | 0.468 | 0.470 | 0.596 (scale 2) | 0.343 |
| accel_magnitude | 0.472 | 0.492 | 0.488 | 0.474 | 0.588 (scale 4) | 0.354 |
| gyro_magnitude | 0.544 | 0.540 | 0.504 | 0.470 | 0.507 (scale 2) | 0.434 |

## Inside pinch holds against outside every hold, sample by sample

| Channel | Level (as in grayscale) | Detail size, scale 2 | Detail size, scale 4 | Detail size, scale 8 | Detail size, scale 16 |
|---|---:|---:|---:|---:|---:|
| ppg_green | 0.635 | 0.525 | 0.526 | 0.530 | 0.526 |
| ppg_red | 0.617 | 0.518 | 0.524 | 0.529 | 0.516 |
| ppg_ir | 0.583 | 0.508 | 0.511 | 0.506 | 0.499 |
| accel_x | 0.506 | 0.502 | 0.495 | 0.494 | 0.485 |
| accel_y | 0.422 | 0.500 | 0.493 | 0.487 | 0.463 |
| accel_z | 0.464 | 0.512 | 0.492 | 0.482 | 0.481 |
| gyro_x | 0.479 | 0.468 | 0.463 | 0.455 | 0.434 |
| gyro_y | 0.500 | 0.496 | 0.489 | 0.479 | 0.463 |
| gyro_z | 0.473 | 0.489 | 0.482 | 0.469 | 0.435 |
| accel_magnitude | 0.496 | 0.505 | 0.497 | 0.490 | 0.474 |
| gyro_magnitude | 0.498 | 0.478 | 0.478 | 0.468 | 0.459 |

Moments (all channels alike): {'pinch': 449, 'random': 1514, 'other': 258}; 2.3 s.
