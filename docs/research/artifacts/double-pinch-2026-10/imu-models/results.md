# Which model finds a pinch contact best from the motion sensors?

14 pinch recordings with camera contacts (278 contacts, 275 releases), 14 recordings with no pinch, 27 minutes in all; days 2026-10-14, 2026-10-17. Contacts found at a false-alarm rate over the test recordings (double pinch: about its square); releases firing at the 1 a minute threshold; window AUC and average precision over decisions.

## Whole recordings held out (5 folds)

| Model | Found at 1/min | 0.5/min | 0.2/min | Double pinch at 1/min | Releases firing | Window AUC | Window AP |
|---|---:|---:|---:|---:|---:|---:|---:|
| jolt threshold | 4% | 1% | 0% | 0% | 1% | 0.846 | 0.230 |
| logistic regression | 8% | 5% | 4% | 1% | 3% | 0.880 | 0.377 |
| ExtraTrees | 60% | 54% | 40% | 37% | 29% | 0.964 | 0.787 |
| gradient boosting | 42% | 35% | 29% | 18% | 12% | 0.944 | 0.666 |
| random convolutions | 35% | 19% | 14% | 12% | 6% | 0.918 | 0.535 |
| CNN | 64% | 46% | 29% | 41% | 14% | 0.968 | 0.805 |
| CNN + orientation | 64% | 53% | 46% | 41% | 15% | 0.963 | 0.772 |

## Each recording day held out

| Model | Found at 1/min | 0.5/min | 0.2/min | Double pinch at 1/min | Releases firing | Window AUC | Window AP |
|---|---:|---:|---:|---:|---:|---:|---:|
| jolt threshold | 3% | 1% | 1% | 0% | 1% | 0.853 | 0.361 |
| logistic regression | 6% | 5% | 3% | 0% | 3% | 0.702 | 0.356 |
| ExtraTrees | 19% | 14% | 7% | 3% | 8% | 0.859 | 0.492 |
| gradient boosting | 11% | 7% | 6% | 1% | 2% | 0.863 | 0.435 |
| random convolutions | 18% | 9% | 2% | 3% | 3% | 0.849 | 0.481 |
| CNN | 27% | 18% | 10% | 7% | 5% | 0.891 | 0.583 |
| CNN + orientation | 14% | 12% | 4% | 2% | 3% | 0.790 | 0.444 |

## Pinch recordings without a camera (12 recordings), trained on all of the above

AUC of the highest score near a labelled pinch start against random windows (0.5 is chance; below it, the model fires more away from pinches).

| Model | all (194 pinches, 502 random) | guided 2026-10-31 (rest, then typing, mouse and arm movement) (40 pinches, 428 random) | earlier sessions (154 pinches, 74 random) |
|---|---:|---:|---:|
| jolt threshold | 0.688 | 0.987 | 0.501 |
| logistic regression | 0.585 | 0.830 | 0.554 |
| ExtraTrees | 0.378 | 0.730 | 0.464 |
| gradient boosting | 0.470 | 0.910 | 0.603 |
| random convolutions | 0.237 | 0.421 | 0.600 |
| CNN | 0.391 | 0.666 | 0.534 |
| CNN + orientation | 0.689 | 0.887 | 0.628 |

1308 s.
