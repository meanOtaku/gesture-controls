# Adapting to a new session, and adding the pulse sensor

Base: step 8's z-score + sigmoid windows and spike CNN; scores are the average of 5 training runs.

## Each recording day held out (2026-10-14, 2026-10-17)

Scored after each held-out day's first 10 pinches (the calibration pinches), for every variant.

| Variant | Found at 1 false alarm/min | 0.5/min | 0.2/min | With the rules: 1/min | 0.5/min | 0.2/min |
|---|---:|---:|---:|---:|---:|---:|
| motion, ±0.2 s | none | 41% | 26% | 15% | 41% | 30% | 16% |
| motion, ±0.2 s | AdaBN | 37% | 22% | 12% | 41% | 28% | 10% |
| motion, ±0.2 s | DANN | 41% | 27% | 15% | 38% | 31% | 12% |
| motion, ±0.2 s | calibration, 5 pinches | 36% | 28% | 12% | 35% | 26% | 10% |
| motion, ±0.2 s | calibration, 10 pinches | 35% | 28% | 12% | 37% | 22% | 13% |
| motion + pulse, ±0.2 s | none | 39% | 27% | 10% | 38% | 31% | 14% |
| motion + pulse, ±0.2 s | calibration, 10 pinches | 36% | 31% | 17% | 36% | 27% | 12% |
| motion, ±0.5 s | none | 43% | 29% | 16% | 38% | 27% | 13% |
| motion + pulse, ±0.5 s | none | 45% | 38% | 24% | 37% | 35% | 29% |
| motion + pulse, ±0.5 s | calibration, 10 pinches | 52% | 43% | 28% | 45% | 38% | 29% |

## Whole recordings held out (5 folds)

| Variant | Found at 1 false alarm/min | 0.5/min | 0.2/min | With the rules: 1/min | 0.5/min | 0.2/min |
|---|---:|---:|---:|---:|---:|---:|
| motion, ±0.2 s | 67% | 49% | 33% | 57% | 50% | 28% |
| motion + pulse, ±0.2 s | 62% | 54% | 34% | 53% | 45% | 33% |
| motion, ±0.5 s | 70% | 58% | 45% | 58% | 48% | 33% |
| motion + pulse, ±0.5 s | 70% | 60% | 46% | 59% | 52% | 44% |

421.1 s.
