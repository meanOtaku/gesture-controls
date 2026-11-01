# Only detect inside steady motion (without the 2026-10-31 recordings)

266 camera-timed pinch contacts with a release. Steady before: -1.0 to -0.1 s from the contact; settles after: 0.3 to 1.2 s after the release.

## Medians

| | acceleration spread (m/s²) | turning (gyro RMS, rad/s) | tilt change (°) |
|---|---:|---:|---:|
| pinch, before | 0.224 | 0.0928 | 1.06 |
| pinch, after release | 0.235 | 0.0922 | 1.16 |
| everything_else recordings | 0.275 | 0.184 | 3.41 |
| fist | 0.136 | 0.0751 | 1.16 |
| wrist twist | 0.332 | 0.762 | 11.8 |
| rest (pinch sessions) | 0.277 | 0.591 | 9.2 |
| thumbs up | 0.0489 | 0.0193 | 0.386 |

## Strictness

Limits are set at a share of pinch windows, or fixed at round values; all three must hold. Activity cells: share of moments open (steady second before) / bracketed (steady again 0.9-1.8 s later).

| Limits from | Limits (spread, turning, tilt) | Pinches steady before | Settle after | Both | everything_else recordings | fist | wrist twist | rest (pinch sessions) | thumbs up |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 80% of pinches | 0.372, 0.478, 9.22 | 75% | 72% | 62% | 53% / 38% | 78% / 66% | 44% / 8% | 42% / 4% | 99% / 95% |
| 90% of pinches | 0.455, 0.893, 20.2 | 87% | 83% | 76% | 64% / 46% | 84% / 74% | 50% / 8% | 54% / 12% | 99% / 95% |
| 95% of pinches | 0.536, 1.12, 28.3 | 93% | 90% | 85% | 69% / 51% | 89% / 80% | 51% / 9% | 75% / 42% | 99% / 96% |
| 98% of pinches | 0.62, 1.51, 34.4 | 97% | 95% | 93% | 74% / 56% | 94% / 88% | 53% / 11% | 88% / 50% | 99% / 96% |
| fixed | 0.3, 0.3, 5 | 63% | 57% | 48% | 41% / 25% | 71% / 58% | 37% / 3% | 38% / 0% | 96% / 90% |
| fixed | 0.4, 0.3, 5 | 69% | 67% | 58% | 50% / 37% | 78% / 66% | 38% / 5% | 38% / 0% | 96% / 90% |
| fixed | 0.4, 0.5, 10 | 77% | 73% | 64% | 54% / 39% | 80% / 68% | 44% / 8% | 46% / 4% | 99% / 95% |
| fixed | 0.5, 0.5, 10 | 79% | 76% | 67% | 56% / 41% | 86% / 76% | 44% / 8% | 46% / 4% | 99% / 95% |
| fixed | 0.6, 0.5, 10 | 79% | 77% | 68% | 58% / 42% | 92% / 85% | 44% / 8% | 46% / 4% | 99% / 95% |

1.3 s.
