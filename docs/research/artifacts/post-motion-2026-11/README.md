# Training on pinches made right after arm motion, 18 November 2026

**Result:** this training closes most of the short blind spot that is left after arm motion.

- After 14 s of motion ending 0.25 s before the pinch, it catches 42 of 50 held-out pinches against 35 for the current
  model. It catches 40 when held to the current model's cut-off.
- After 10 s ending 0.25 s before, it catches 46 against 41.
- It catches about one pinch fewer elsewhere, including 46 against 47 with no motion.
- On the ordinary held-out recordings it is no worse at the same threshold. At 0.995 it catches 66 of 89 pinch-ins at
  2.0 false activations an hour, against 62 at 4.1.
- But its own training chose a lower cut-off (0.85 against 0.9), where it fires 12.2 times an hour against 8.1.

All of this is one seed per variant and 0.49 h of held-out no-gesture time, where one false activation is 2 an hour.
So the false-activation differences are within noise, and the gain right after motion needs more seeds before it is
trusted.

## Setup

See `experiment.py`.

- `base` retrains the application's current model (`pinch_in-8f79677396d8`: CNN v2, 100 Hz, pinch in, hold and out)
  from its spec, with hand labels and seed 17. It scores identically to the application's model, `app-current`.
- `post` adds two copies of each training gesture recording. In each copy, 1–12 s of real arm motion from the
  training everyday-noise recordings is spliced in before a pinch-in start, ending 0.1–3 s before it. This adds
  190 spliced starts and about 20,000 decisions.
- The splice test uses held-out motion only.

## Splice test (held-out pinch-ins caught, each model at its own cut-off)

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

- Run seeds 18 and 19 for both variants: `experiment.py train base 18`, and so on.
- If the gain holds, make it a trainer option. Never replace the active model; train a new Model Lab version
  alongside it.
