# What Rylo et al. (2022) teaches the pinch models

Rylo, de Medeiros and de Lucena Jr., *Gesture recognition of wrist motion based on wearables sensors*, Procedia Computer
Science 210 (2022) 181–188. Same watch as this app (Galaxy Watch 4, PPG at 25 Hz, motion at 100 Hz), seven wrist and
finger gestures from people sitting still, pre-cut 3 s windows, 147 statistical features, a random forest: F1 0.82 for
seven gestures, 0.92 for five.

Its ideas, tried on the trees pinch model (13 Nov 2026). Same recordings and test as
`../training-improvements-2026-11/`: train on the 22 recordings the live models trained on, score the 11 they never saw.
32 of the 33 hold motion at 100 Hz.

## As the app's training would judge them (`as_trained.py`, `as-trained.md`)

Cut-off chosen on the training recordings only; the unseen recordings replayed once at it.

| gesture | model | caught | false activations an hour | median delay |
|---|---|---|---:|---:|
| pinch_in | trees (today) | 89/128 (70%) | 1.8 | 934 ms |
| pinch_in | trees + spectral | 99/128 (77%) | 1.8 | 918 ms |
| pinch_in | trees @100 Hz | 99/128 (77%) | 3.5 | 933 ms |
| pinch_in | trees + spectral @100 Hz | **111/128 (87%)** | 3.5 | 918 ms |
| pinch_in | CNN (the default) | 95/120 (79%) | 3.6 | **451 ms** |
| pinch_out | trees (today) | 115/134 (86%) | 8.5 | 908 ms |
| pinch_out | trees + spectral | 114/134 (85%) | 18.7 | 911 ms |
| pinch_out | trees @100 Hz | **118/134 (88%)** | **5.1** | 908 ms |
| pinch_out | trees + spectral @100 Hz | 117/134 (87%) | 6.8 | 908 ms |
| pinch_out | CNN (the default) | 96/127 (76%) | 3.4 | **434 ms** |

The CNN's rows are from `../training-improvements-2026-11/final-models.md`. It counts fewer pinches (it cannot score the
first 11 s of a recording), so compare it by the shares.

## What each idea did (`paper_experiments.py`, `results-*.md`, best cut-off per variant, two seeds)

1. **Motion sample rate: it matters, and 100 Hz is better.** The motion features on a 25 Hz grid lost about 25 pinches
   in; on 100 Hz they gained about 10 in and 20 out, with fewer false activations out (8.5 to 5.1 an hour, as trained).
   The one consistent gain. (For the CNN, 100 Hz did not help: `../training-improvements-2026-11/results-pinch_in.md`.)
2. **Spectral motion features: helped pinch in, not pinch out.** Band power, peak frequency, centroid and entropy of each
   motion channel (216 features) added about 10 pinches in, and with 100 Hz, 22. Out, they did nothing at best and, as
   trained, more than doubled the false activations (the model took 4 pinch ins for pinch outs). Not a safe change alone.
3. **Fewer features: the paper's finding holds.** The 200 or 500 features the trees rated most useful did as well as all
   2,733; 50 lost about 12 pinches. Worth it only for speed: the trees train and score faster on a tenth of the inputs.
4. **Which gestures are taken for which: not a problem here.** The paper lost accuracy to look-alike gestures. Here the
   few false activations at the best cut-offs fall on everyday noise and unlabelled time, not on pinch out or pinch hold;
   the exception is pinch out with spectral features (above).

Unlike the paper, the trees rely on the pulse sensor: their most useful features are the red and green PPG (`ppg_z..._red_...`),
with the accelerometer's spread second. The paper found PPG too slow to classify with; here, deciding *when* a pinch
starts, it carries the most.

## The CNN at 100 Hz (`as_trained.py cnn cnn@100`, 14 Nov)

The CNN on the 100 Hz grid of `../training-improvements-2026-11/experiment.py` (twice the ticks over the same second and
10 s, a fourth convolution), trained as the app trains it, two seeds:

| gesture | CNN | seed 17 | seed 18 | median delay |
|---|---|---|---|---:|
| pinch_in | 50 Hz | 95/120 at 3.6 an hour | 91/120 at 3.6 an hour | 451-494 ms |
| pinch_in | 100 Hz | 96/120 at 3.6 an hour | 92/120 at 3.6 an hour | 434-451 ms |
| pinch_out | 50 Hz | 96/127 at 3.4 an hour | 92/127 at 0 an hour | 434-444 ms |
| pinch_out | 100 Hz | **102/127** at 3.4 an hour | **100/127** at 3.4 an hour | 449-468 ms |

Pinch in: one more pinch a seed, the same false activations: no real change. Pinch out: 6 to 8 more pinches (about 5%),
with at most 2 false activations more over the 11 recordings. Unlike the earlier comparison (best cut-off chosen on these
recordings, older training loops), the CNN does gain a little from 100 Hz, on pinch out. It is not made the CNN's input
here: that is its own change (`cnn_input` in the trainer and the runtime, the network's fourth convolution, the manifest).

## Done (14 Nov)

The trees now read motion at 100 Hz: the trainer's `imu_onset` has both grids and new trees motion models use 100 Hz and
say so in their manifest (`preprocessing.motionHz`); the runtime reads each model's motion on the grid it names, the
models from before on 50 Hz; the watch's motion rates default to 100 Hz.

## What it took

The trees still decide about half a second later than the CNN (about 0.9 s against 0.45 s after the pinch starts), which
the CNN was made the default for. If the trees' extra catch is wanted anyway, 100 Hz motion is the change to make:

- the watch streaming motion at 100 Hz (it defaults to 50; a Galaxy Watch4 delivers at most 100), at some battery cost;
- the trees' motion features on a 100 Hz grid in the trainer (`imu_onset.py`) and, matching it, in the runtime
  (`crates/pinch-inference/src/imu_onset.rs`), with the parity fixtures regenerated;
- the model's input contract saying 100 Hz, so a model is never fed a stream at the other rate.

Spectral features for pinch in only would be a second, separate step.
