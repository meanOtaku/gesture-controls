# Training on pinches made right after arm motion, 18–19 November 2026

**Result, over three seeds (17, 18, 19):** this training helps right after long motion, by less than the first seed
suggested, and costs a few pinches on ordinary recordings.

Compared seed by seed with the retrained current model (`base`), both held to the current model's cut-off of 0.9:

| Splice test, held-out pinch-ins caught of 50 | base 17 / 18 / 19 | post 17 / 18 / 19 | mean gain |
|---|---|---|---|
| no motion | 47 / 46 / 46 | 46 / 47 / 46 | 0 |
| 14 s of motion, ending 0.25 s before | 35 / 32 / 32 | 40 / 33 / 39 | +4.3 |
| 14 s, 0.5 s before | 42 / 39 / 40 | 45 / 40 / 41 | +1.7 |
| 10 s, 0.25 s before | 41 / 42 / 43 | 45 / 44 / 45 | +2.7 |
| 6 s, 0.25 s before | 44 / 40 / 41 | 46 / 45 / 46 | +4.0 |
| 1 s or more before, any length | 45–49 | 45–48 | about 0 |

- The gain right after motion shows in every seed, but seed 18 gains only 1 in the hardest case.
- On the 17 ordinary held-out recordings at 0.9, it catches 67 / 74 / 67 of 89 pinch-ins against 68 / 76 / 75, and
  fires 8.1 / 10.1 / 6.1 times an hour against 8.1 / 20.3 / 8.1. So it catches about 4 fewer on average and fires a
  little less.
- Seeds differ by as much as the variants do: base 17 and 18 catch 68 and 76 on the same recordings.
- Its own training chose cut-offs of 0.85, 0.98 and 0.85. Seeds 19 of both variants were judged not deployable on
  their own held-out false activations (8 and 10 an hour against at most 5).
- `base-17` scores identically to the application's model, `app-current`.

0.49 h of held-out no-gesture time means one false activation is 2 an hour, so the false-activation differences are
within noise.

## Setup

See `experiment.py`.

- `base` retrains the application's current model (`pinch_in-8f79677396d8`: CNN v2, 100 Hz, pinch in, hold and out)
  from its spec, with hand labels and seed 17. It scores identically to the application's model, `app-current`.
- `post` adds two copies of each training gesture recording. In each copy, 1–12 s of real arm motion from the
  training everyday-noise recordings is spliced in before a pinch-in start, ending 0.1–3 s before it. This adds
  190 spliced starts and about 20,000 decisions.
- The splice test uses held-out motion only.

## Splice test, seed 17 only (held-out pinch-ins caught, each model at its own cut-off)

| Motion, ending before the pinch | Current model | Post-motion training |
|---|---|---|
| none | 47/50 | 46/50 |
| 6 s, 0.25 s before | 44/50 | 46/50 |
| 10 s, 0.25 s before | 41/50 | 46/50 |
| 14 s, 0.25 s before | 35/50 | 42/50 |
| 14 s, 0.5 s before | 42/50 | 45/50 |
| 1 s or more before, any length | 46–47/50 | 46–47/50 |

`results.md` has every condition and the full threshold sweep.

## Next

- The gain is real but small, and pays for itself only for someone who often pinches within half a second of long
  motion. If it is wanted, make it an opt-in trainer option. Never replace the active model; train a new Model Lab
  version alongside it.
