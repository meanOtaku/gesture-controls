# Replay assets: operating curves and event confusion

The data and figures behind the paper's operating-curve figure (`fig-operating`) and the current model's event
confusion matrix (`fig-event-confusion`). Both come from replaying model files over recordings; nothing is trained and
no number is typed in.

| File | What it is |
| --- | --- |
| `replay_figures.py` | Replays both models, sweeps the activation threshold, counts events, and plots |
| `replay-sweeps.json` | Per threshold: caught/eligible starts, late, repeats, false activations, no-gesture time, latency; plus the event confusion |
| `operating-curve.pdf/png` | Event recall against false activations per hour, first model vs the application's current model |
| `event-confusion.pdf/png` | Which detector fired for each annotated start, misses, and false activations, for the current model |

## What is replayed

- **Recordings:** the eight evaluation recordings of the first model (`pinch_in-ae0a22bf`). They are also the trusted
  held-out cohort of the current model; this was checked by hashing their sensor columns.
- **First model:** `trained-models/pinch_in-hand-labeled`, scored with the trainer at `c924661` (the one it was trained
  with). The script asserts it reproduces 47/57 caught with no false activation at its 0.99 threshold.
- **Current model:** the application's `pinch_in-8f79677396d8` (pinch-in, pinch-hold, pinch-out), read from Model Lab,
  scored with the trainer at `07e6915f` and its stored run spec and jerk gate. The script asserts 40/57 and four false
  activations at its 0.90 pinch-in threshold.
- **Match window:** 300–900 ms for both, as in the paper. The application's later 100–900 ms window reproduces the
  current model's stored figures (42/57, 55/59, 38/55).
- **Thresholds:** swept on these evaluation recordings for display only; each model's operating threshold was chosen on
  its training recordings.

## Running

```bash
tools/label-trainer/.venv/bin/python docs/paper/replay-assets/replay_figures.py
```

```bash
docs/paper/codex-assets/.venv/bin/python docs/paper/replay-assets/replay_figures.py --plot
```

The first command takes about two minutes on a laptop CPU and needs the current model's files in Model Lab
(`MODEL_LAB`, default `~/Library/Application Support/dev.meanotaku.spatial-gesture-control/model-lab`); they are not in
the repository. After plotting, copy the two PDFs to `../manuscript/figures/`.

The first model's sweep also reproduces the manuscript's sensitivity statement (one false activation at 0.98, two at
0.95), which `revision-assets/hand-labelled-replay.json` records but no script there produces.
