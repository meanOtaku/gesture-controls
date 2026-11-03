# Trees vs CNN on camera-timed old and new sessions (pinch_in)

Budget: 30 false activations an hour with no gesture under way. Each model at its own threshold (chosen on its training recordings). TAR = caught / pinches; FAR per hour with no gesture under way; repeats per 100 pinches; late = fired during a pinch it missed; latency = median ms from the pinch's start to its catch.

| Model | Trained on | Threshold | New sessions (3 Nov): TAR | FAR/h | rep/100 | late | ms | Old held-out (14, 17 Oct): TAR | FAR/h | rep/100 | late | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| trees | old only | 0.65 | 16/58 (28%) | 40 | 0 | 0 | 919 | 13/34 (38%) | 138 | 0 | 0 | 911 |
| trees | old + new (4 folds) | 0.95, 0.90, 0.95, 0.90 | 6/58 (10%) | 80 | 0 | 2 | 854 | 5/136 (4%) | 34 | 0 | 0 | 870 |
| cnn | old only | 0.95 | 35/55 (64%) | 193 | 0 | 16 | 397 | 15/30 (50%) | 144 | 0 | 1 | 539 |
| cnn | old + new (4 folds) | 0.60, 0.80, 0.70, 0.90 | 37/55 (67%) | 168 | 0 | 8 | 415 | 62/120 (52%) | 144 | 0 | 3 | 495 |
| live cnn | in the app (old sessions only) | 0.75 | 37/55 (67%) | 193 | 0 | 17 | 414 | 19/30 (63%) | 72 | 0 | 0 | 493 |

Old held-out totals of the 4-fold runs add the same two recordings once per fold.

## Diagnostic: the best threshold on the held-out recordings (never used to choose one)

| Model | Trained on | New: best TAR within budget (threshold) | Old: best TAR within budget (threshold) |
|---|---|---|---|
| trees | old only | 0/58 (0%) at 0.95 | 7/34 (21%) at 0.85 |
| trees | old + new (4 folds) | some folds none | 0/136 (0%) at 0.95, 0.95, 0.95, 0.95 |
| cnn | old only | none within budget | 15/30 (50%) at 0.99 |
| cnn | old + new (4 folds) | some folds none | some folds none |
| live cnn | in the app (old sessions only) | none within budget | 16/30 (53%) at 0.97 |
