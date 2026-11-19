# Multi-gesture CNN with snap, after the snap relabelling, 19 November 2026

The five snap recordings were relabelled with tighter starts (train e186a56e, b780a0dc, d6600889; held out 6e951951,
74803bf6), and the four-gesture model (pinch in, hold, out and snap; CNN v2, 100 Hz, seed 17) was retrained on the
same 27 training and 19 held-out recordings as `run-b936cb596c`. `compare.py` replays both, gate included, against
the labels as they are now.

| Gesture | before: caught | before: false/h | after: caught | after: false/h |
|---|---|---|---|---|
| Pinch in | 74/89 | 5.4 | 71/89 | 0.0 |
| Pinch hold | 59/79 | 16.2 | 63/79 | 18.0 |
| Pinch out | 86/87 | 16.5 | 86/87 | 16.5 |
| Snap | 21/38 | 12.6 | 31/38 | 7.2 |

Each model at its own cut-offs. False/h is false activations an hour with no gesture under way, over 0.55 h.

- Snaps caught go from 21 to 31 of 38, with fewer false activations; at 0.95 it still catches 26 at 1.8 an hour.
- Pinches are about the same.
- But 18 of the 38 snaps also take pinch-in past its cut-off, against 4 before (event confusion in `results.md`). In
  the app a snap may also trigger the pinch-in action.
- Median snap latency rises from 369 ms to 594 ms. Probably the tighter labels start earlier; not checked.

The new run was not imported into Model Lab.

    tools/label-trainer/.venv/bin/python docs/research/artifacts/snap-multi-2026-11/compare.py OLD_RUN NEW_RUN
