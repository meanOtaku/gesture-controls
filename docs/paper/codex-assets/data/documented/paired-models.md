# The trainer's new loop, run as the app runs it

Cut-off chosen on the training recordings only; the 11 held-out recordings replayed once at it. See
`final_models.py`.

| model | outcome | cut-off | caught | false activations an hour | median delay |
|---|---|---:|---|---:|---:|
| pinch_in | deployable | 0.99 | 95/120 | 3.6 | 451.468647 ms |
| pinch_out | deployable | 0.99 | 96/127 | 3.4 | 434.047786 ms |

What it shows (13 Nov 2026, the cut-off chosen within 5 false activations an hour):

- Both cut-offs were chosen by the trainer; neither was set by hand. Under the earlier budget of 30 an hour the same
  training chose 0.96 for `pinch_in` (97 of 120 caught, 3.6 an hour) and 0.5 for `pinch_out` (101 of 127, 30.8 an hour, not
  deployable).
- The live `pinch_in-motion` model, its cut-off set to 0.99 by hand, caught 96 of 119 on the same recordings with 1 false
  activation. The new loop is no better at catching; what changed is that the cut-off no longer needs setting by hand.
