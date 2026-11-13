# The pinch models: trees and CNN

The app detects a gesture with **one model per label**, run on the watch's pulse sensor and motion. A label's model can be
one of two kinds, trained by the same trainer (`tools/label-trainer`) and judged by the same rules. This page says how
each works, how training goes, where they stand, and how to train on another machine, including one with an older NVIDIA
card such as a GTX 1050 Ti.

Related: [Gesture detector evaluation metrics](../research/gesture-detector-evaluation-metrics.md) (how models are judged),
[label inference](label-inference.md) (how they run in the app).

## The two models

Both answer one question at every pulse sample: did the gesture just start? They read the same sensors and differ in what
they are shown, how they decide, and how much they learn from.

| | **Trees** (`ppg-onset-trees`) | **CNN** (`ppg-imu-cnn`) |
|---|---|---|
| Input | 2,733 summary numbers worked out by code | The raw signals: 9 channels × 50 steps = 450 numbers |
| Sensors | Pulse (green, red, infrared), accelerometer, gyroscope | The same |
| What it sees | Statistics of the last 0.3, 0.6 and 1.3 s | The last 1 s, each channel scaled by its own last 10 s |
| Model | 300 decision trees that vote (ExtraTrees) | 3 small neural networks, averaged |
| Moments learnt from | Chosen ones: about 1,000–1,300 | Nearly every pulse sample: tens of thousands |
| Decides | About 0.88 s after a gesture starts | About 0.5 s after |
| Catches a start | 0.68–1.28 s after it | 0.3–0.9 s after it |
| Data needed before scoring | About 5.6 s | 11 s |
| File | `model.trees` | `model.cnn` |
| Training needs | numpy, scikit-learn | PyTorch; much faster on a GPU |

### Trees

Code in `ppg_onset.py` and `imu_onset.py` describes each moment, then the trees find rules on those numbers.

- **Pulse (1,701 inputs):** each moment is compared with the 1, 2 and 4 s before it (a z-score against each). Its slope,
  curvature and jerk are worked out from the samples before it, and 21 statistics of those are taken over the last 0.3, 0.6
  and 1.3 s.
- **Motion (1,032 inputs):** the same statistics of each axis, its size and its change, and how much it moved against the
  3 s before.
- **Learns from** (`ppg_onset.sample_decisions`): as the gesture, the moment 0.88 s after each start. As not the gesture:
  the same moment after other gestures' starts, up to 20 moments inside holds and 20 in quiet time per recording, and moments
  just after a start, which stop it firing too early. A recording with no start of the gesture gives about 30 moments a
  minute instead.
- **Settings:** 300 trees, at least 3 samples a leaf, 70% of the inputs per split. These came from the research and are not
  tuned per run.

It works from little data and trains quickly, but it only sees what the summaries describe.

### CNN

`cnn_input.py` builds the input and `cnn.py` trains it. `crates/pinch-inference/src/cnn_input.rs` builds the same input live,
and `tests/fixtures/cnn_input_cases.json` keeps the two equal.

- **Input:** accelerometer, gyroscope and pulse (9 channels) on a 50-a-second grid. Each channel is centred and scaled by the
  median and median absolute deviation of its last 11 s, leaving out the moments the wrist was turning fast (gyroscope RMS
  over 0.3 s above 1 rad/s, and 0.5 s either side; never the last second), and put through a sigmoid, and the last second
  goes in. So a pinch is caught as soon as the hand is steady again, however long the arm moved before. Models of the
  earlier `ppg_imu_cnn` kind used a rolling 10 s mean and deviation, and keep running that way, but a burst of motion leaves
  them nearly blind for 10 s ([why](../research/cnn-motion-hangover-2026-11.md)).
- **Network:** three dilated convolutions (32, 32 and 64 channels, kernel 5, dilation 1, 2, 4), each with batch normalisation;
  each channel's maximum and mean over time; a dense layer of 32 with dropout; one output.
- **Three networks** are trained from different seeds and their probabilities averaged, which steadies the score.
- **Learns from** (`cnn.labels`): as the gesture, every pulse sample 0.4–0.6 s after a start. As not the gesture, every sample
  with no start from 1.2 s before it to 0.2 s after it. Each network trains on all the gesture moments and at most 40,000
  others, picked at random, so with a lot of noise each network sees part of it and the three together see most of it.
- **Settings:** 20 passes, batches of 256, Adam at 0.001 following a cosine down to zero, weight decay 0.0001, gesture
  moments weighted up to 3×. Each batch is changed a little as another wearing of the watch might change it: every channel's
  size scaled by 0.8 to 1.25, noise added, the window moved by up to 40 ms, and the pulse blanked in 15% of the windows
  (`cnn._augmented`). Until 12 Nov it was 12 passes at a fixed rate, a weight of up to 20× and no such changes; over six
  seeds the new loop caught 99 of 120 held-out pinches against 95 within 5 false activations an hour, with its best cut-off
  between 0.7 and 0.98 instead of 0.97 and 0.995
  ([results](../research/artifacts/training-improvements-2026-11/results-pinch_in.md)). On the same test, the motion at 100
  times a second caught no more than at 50 (94 against 96, two seeds), and a 2 s window caught 96 of 118 against 95 of 120.

It finds signal shapes nobody wrote code for and fires sooner. Because every channel is scaled by its own recent level, it
sees the shape of a movement rather than its size: after stillness, a small twitch can look as large as a pinch. That is why
it needs everyday noise to train on.

### What both share

- **Detection rule** (`events.py`, equal to the runtime's by `tests/fixtures/detection_cases.json`): the detection comes at the
  top of the score's climb once it reaches the threshold. It ends when the score falls 0.15 under the threshold, and the
  next one waits 1.5 s.
- **Still hand:** with the setting on, the app only lets a gesture start after a still moment (`steadiness.py`), and training
  and testing keep only those moments. Leave it off for these models (see below).
- **Standard labels:** `everyday_noise`, `still` and `supported` always count as not the gesture.
- **Output folder:** `bundle/` holds `manifest.json` and the model file, and Model Lab imports it. The app runs both kinds
  itself, with no Python.

## How training goes

The app does this when you press **Train**; the command line does the same from a `spec.json` (see below).

1. **Read** the recordings the spec names, split into training and test recordings. A recording is never in both.
2. **Pick the moments** to learn from and build their inputs.
3. **Train** the model.
4. **Choose the threshold on the training recordings only.** Five more models, each trained without a fifth of them, score
   the part they did not see. Those are replayed as the app would run them, and the threshold that catches the most starts
   within **5 false activations an hour** wins (30 until 13 Nov 2026; the results below were measured under 30).
5. **Replay the test recordings** at that threshold and count catches, repeats, late firings and false activations, as the
   [evaluation standard](../research/gesture-detector-evaluation-metrics.md) defines them.
6. **Export** the model and check the file gives the trained model's answers.
7. **Write** `bundle/`, `evaluation.json`, `inspection.json` and `result.json`. A model that fails the checks for going live is
   still written, as monitor-only.

**Learn from its own false alarms** (`hardNegatives`) adds a step after 3: the model is replayed over its training recordings,
each false activation becomes one more "not the gesture" example, and it is trained again.

**A training plan** (`stages`, CNN only) replaces step 3's single fit: the networks train through the stages in order, each
continuing from the weights the stage before left (`cnn.fit_stages`). A stage takes its recordings' moments; a rehearsing
stage also takes every start and half the other moments of the earlier stages' recordings (`label_train.stage_rows`). False
alarms learnt from go into the last stage, and the out-of-fold models that choose the threshold follow the same plan, each
without its fold's recordings. The desktop removes the recordings held out for testing from every stage before writing the
spec. A plan is recorded in the manifest's `provenance.trainingStages`.

**Thresholds after training.** The registry, not the bundle, holds the thresholds a model runs under, so they can be changed
later (`set_label_model_threshold`, `Registry::set_thresholds`): the release keeps its distance below the activation unless
given, the runtime picks the change up when it reloads, and each change is kept in the version's `thresholdChanges`.

## Where they stand (4 Nov 2026)

Full results: [`cnn-all-days-2026-11`](../research/artifacts/cnn-all-days-2026-11/results.md), and for trees against the CNN,
[`camera-old-new-2026-11`](../research/artifacts/camera-old-new-2026-11/results.md).

- **Use the CNN.** On new sessions it caught about two thirds of the pinches, against 10–28% for the trees, about 0.4 s
  sooner.
- **Train it on every camera-timed pinch session plus everyday noise, with the still-hand rule off.** That rule also removes
  from training every moment the hand was moving, so a model trained under it never learns that movement is not a pinch.
  With each day held out, on 372 camera-marked pinches:

| Trained | Pinches caught | False an hour, unseen noise | False an hour, pinch sessions |
|---|---:|---:|---:|
| Live CNN (October only, no noise) | 204 (55%)* | 143 | 23 |
| With the rule | 146 (39%) | 23 | 20 |
| **Without the rule** | **161 (43%)** | **7** | 49 |
| Without it, the rule on when running | 130 (35%) | 3 | 16 |

  \* It trained on most of the October pinches, so that figure is not on unseen data. The 49 an hour comes from one day: 10
  false activations in 95 s of pauses on 17 Oct, the sessions with the most pinches the camera could not mark. The other days
  match the row above (0–28 an hour).
- **Leave Learn from its own false alarms off.** With noise in training it found 2–70 mistakes per fold, and it caught
  fewer pinches (27% against 31%) for no fewer false activations.
- **A 2 s window beats 1 s, with a fourth convolution so the filters reach 1.2 s.** The window ends at the same moment, so it
  decides no later. On two seeds, at a threshold holding about 20 false activations an hour, it caught 49–51% against 45%.
  On 3 and 4 Nov it caught about 95% (1 s: about 75%), mostly by firing on time: on 3 Nov, 1 late pinch against 23. October
  barely moved. Its threshold, chosen on the training recordings, let in 33–65 false activations an hour on unseen noise, over
  the budget, many of them on fists, so it needs a stricter choice. The buzz at each cue does not explain the gain: with the
  motion before each touch replaced by earlier rest, 140 of 150 pinches still fired, against 141. Nearly all recorded pinches
  follow a still hand, so how it does after movement is unknown. The app does not run this window yet.
- **Don't pretrain it on unlabelled data.** Teaching its convolutions to fill in hidden stretches of a window first
  (`pretraining.py`, one seed) caught 48% against 43% at its chosen threshold, but with 27 false activations an hour on noise
  against 7. Compared at about 21 false activations an hour across all held-out data, it caught 152 pinches against 168.
- **Mark pinches against each session's own hand.** How close the fingers look depends on how the hand faces the camera, so a
  fixed level of 0.35 hand sizes missed many real pinches, which then trained as not-a-pinch and were counted as false
  activations. Judged per session (`edges` in `scripts/relabel_pinch_from_camera.py`, and `PinchDips` in the app), false
  activations on the pinch sessions fell from 110 an hour to 20, and the threshold on 4 Nov from 0.99 to 0.65. The earlier
  results are in `results-before-adaptive-marks.md`.

The models to use are built by `final_models.py` beside `results.md`, for `pinch_in` and `pinch_out`: they train on everything
but one pinch session and one noise session. Their cross-checks caught 58–59% within 28 false activations an hour, and on the
sessions they never saw, 15 of 20 and 18 of 21. The corrected marks are only in the folders under `data/recordings/`:
Model Lab's copies keep the old marks until deleted and added again.

Marks saved under 0.2 s are restored to the length they lasted when a session joins Datasets: a mark is saved as a range of
rows, rows land in bursts, and the trainer ignores a mark under 0.2 s. Recordings added to Model Lab before that fix keep
their short marks too.

Still open:

- **The 14 Oct sessions are caught poorly by every model trained on other days:** 12–18%, against 63–75% on 3 and 4 Nov. Their
  threshold rose to 0.98. They are the only ones with the rule off that stay low: 17 Oct went from 15% to 71%, and the same
  model with the rule on when running catches 19%, so the rule itself was blocking most of that day's pinches.
- **Pinches made while moving are barely in the data,** so how often it catches those is unknown.

## Training on another machine

### What a GTX 1050 Ti can run

The 1050 Ti is a **Pascal** card (CUDA `sm_61`). Recent PyTorch builds no longer include code for it, and the version this
repo locks (`torch` 2.15) has no CUDA 12.6 build, the last line that does:

| PyTorch build | On a 1050 Ti |
|---|---|
| CUDA 12.8 and later (the default on Linux) | Sees the card, then fails with "no kernel image". [Dropped for Pascal](https://dev-discuss.pytorch.org/t/cuda-toolkit-version-and-architecture-support-update-maxwell-and-pascal-architecture-support-removed-in-cuda-12-8-and-12-9-builds/3128) |
| CPU-only (the default on Windows) | Runs on the processor, ignoring the card |
| **`2.14.1+cu126`** | **The newest that should run it**: the last CUDA 12.6 release on [PyTorch's server](https://download.pytorch.org/whl/cu126/torch/) |

Not tried on a real 1050 Ti yet: step 4 below is what proves it. The trainer tests the GPU before using it, so a build that
cannot run the card falls back to the processor with a message instead of crashing.

The card's 4 GB is plenty: the network is tiny, and a whole training set takes under 100 MB of it. Nobody has timed this card
yet, so run step 4 before planning around it. For scale, an M3's GPU takes 3–8 minutes a model.

### Steps

The commands are for Linux; on Windows use PowerShell, `.venv\Scripts\python` for `.venv/bin/python`, and `$env:NAME = "value"`
to set a variable.

**1. Install the driver.** `nvidia-smi` should list the card and show a CUDA version of 12.6 or higher. Linux driver branch
580 is [the last for Pascal cards](https://www.phoronix.com/news/NVIDIA-580-Linux-Driver-Last-HW); do not move past it.

**2. Get the code**, and install [uv](https://docs.astral.sh/uv/).

```bash
git clone git@github.com:meanOtaku/gesture-controls.git
```

**3. Install the trainer, then the PyTorch build for this card.** Run these in `tools/label-trainer`. Leave out `--extra cnn`:
it would install the locked build that cannot run the card.

```bash
uv sync --python 3.12 --extra dev
```

```bash
uv pip install "torch==2.14.1" --index-url https://download.pytorch.org/whl/cu126
```

**4. Check the card.** Still in `tools/label-trainer`:

```bash
PYTHONPATH=src .venv/bin/python -m label_trainer.gpu_check
```

It should say `The trainer will use: cuda` and name the card (`sm_60` in the list of supported cards covers `sm_61`). It then
times one training pass and one scoring pass on the card and on the processor. A full model is about 200 passes, so
multiply to see how long a run will take. If the card is slower than the processor, set `LABEL_TRAINER_DEVICE=cpu` for real
runs.

**5. The recordings are already there.** Every recording the script trains and tests on is in the repo, under
`data/recordings/`, so nothing needs copying. To also compare with the live CNN, copy
`~/Library/Application Support/dev.meanotaku.spatial-gesture-control/model-lab/label-models` from the Mac into a folder such
as `~/model-lab/`, and set `MODEL_LAB_DIR=~/model-lab`. Without it, that comparison is left out.

**6. Train.** From the repo's top folder, `anytime` runs the configuration that did best, one model for each held-out day:

```bash
rm docs/research/artifacts/cnn-all-days-2026-11/results.json
```

```bash
tools/label-trainer/.venv/bin/python docs/research/artifacts/cnn-all-days-2026-11/all_days_check.py anytime
```

The first command matters: the script skips any held-out day already in `results.json`, so with the committed file it would
finish at once and train nothing. The log says which device it trains on. `results.md` is rewritten after each day, and each
model is under `runs/plain-<day>/bundle/`.

To train one model of your own, write a spec and run the trainer on it:

```json
{
  "version": 1,
  "target": "pinch_in",
  "negatives": ["pinch_hold", "pinch_out", "fist", "hand_open", "everyday_noise", "still", "supported"],
  "excludes": ["left_out"],
  "recordings": { "session-a": "/path/to/folder-a", "session-b": "/path/to/folder-b" },
  "train": ["session-a"],
  "evaluation": ["session-b"],
  "sources": ["watchPpg", "watchOrientation"],
  "backend": "ppg-imu-cnn",
  "seed": 17,
  "labelTiming": { "session-a": "camera", "session-b": "camera" },
  "steadyStarts": true
}
```

```bash
PYTHONPATH=tools/label-trainer/src tools/label-trainer/.venv/bin/python -m label_trainer.label_train --spec spec.json --out runs/mine
```

Every recording must be in `train` or `evaluation`, and every label in them must have a role. Leave out `"backend"` for the
trees. In `labelTiming`, use `camera`, `estimated` or `noGesture` (a recording with no gesture in it).

**7. Bring the model back.** Copy the `bundle/` folder to the Mac, and in Model Lab use **Import a model folder** under Label
models. It arrives as a Draft and has to be approved and activated like any other.

### If something goes wrong

| What you see | Why, and what to do |
|---|---|
| `The trainer will use: cpu`, with "no kernel image" | The PyTorch build has no code for the card. Repeat step 3 and check the version with step 4 |
| "This PyTorch build has no GPU support" | A CPU-only build was installed. Repeat the `uv pip install` line |
| The version went back to 2.15 | `uv run --extra cnn` or `uv sync --extra cnn` replaced it. Use `.venv/bin/python` directly, and repeat step 3 |
| It runs on the processor from the app's **Train** button | The app runs `uv run --extra cnn`, which installs the locked build. On this machine, train from the command line |
| `no recording at …` | The clone is incomplete, or missing the recordings: run `git pull` |
| It finishes at once and trains nothing | `results.json` is still there: see step 6 |
| "the exported model differs from the trained one" | The file did not match the network closely enough on this GPU, so the model is not shipped. Run again with `LABEL_TRAINER_DEVICE=cpu` |
