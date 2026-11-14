# Why live pinches were missed (miss recorder, 13 November 2026)

**Data.** The ten miss-recorder snapshots saved on 13 Nov (app data, Model Lab datasets group "Misses",
plus `model-lab/misses/miss-2026-11-13T08-09-18.714Z`). Each holds the last 45 s of watch data and the
live log (scores, detections, resets, gaps). Nine have hand labels. Their windows overlap, so they were
merged onto one timeline per session: session 1 (12:59, 23 pinch-ins) and session 2 (13:41, 12).
The app was in **Monitor** mode, so nothing was acted on even when a pinch was detected.

Scripts and the signal plot are in [`artifacts/live-misses-2026-11/`](artifacts/live-misses-2026-11/).
They read the user's local app data; `replay_misses.py` needs the trainer at `c924661`
(see `docs/paper/revision-assets/report_figure_data.py` for why).

## Findings

| Question | Result |
|---|---|
| Pinch-out detection live | 28/30 labelled starts detected |
| Pinch-in detection live (model `pinch_in-006520687b90`) | 18/35 |
| Same pinches, stored model `pinch_in-ae0a22bf` (active now), replayed | session 1: 8/21 (same 11 missed); session 2: **12/12** (live model 9/12) |
| Stream gaps or resets in the nine labelled windows | none; scores continuous through every reset |
| Lowering the activation threshold (live scores) | 0.90 → 22/35, 0.70 → 24/35; at least 11 misses peak below 0.7 |

**1. Quick taps are never caught: 0/9.** A pinch released at once (no `pinch_hold`) scores 0.07–0.78.
The training data has 13 such pinches out of 233 (median hold 540 ms), and `pinch_out` is a negative,
so a release inside the same 1 s input window pulls the score down. Held pinches: 18/26 live.

**2. Pinches right after turning the wrist are weaker.** No training hold contains sustained wrist
rotation (0% above 0.3 rad/s); 37% of live holds do, because that is the "turn" in look-pinch-turn.
Held pinches with a turn in the 3 s before: 3/6 caught; without: 15/20. Small numbers; suggestive.

**3. Live use is moving more than the training data.** Median wrist motion in the 1.3 s before a
pinch: training 0.01 rad/s, live caught 0.12, live missed 0.17. Above 0.2 rad/s: 0/7 caught; only 4 of
233 training pinches are there. Pinches were also closer together (median 3.5 s live vs 6.4 s in
training), with a weak downward trend in catch rate as more pinches fall in the 11 s history.

**4. The live model was weaker than the stored one.** Three held misses in session 2 are caught by
`ae0a22bf`, which is active again. `pinch_in-006520687b90` is no longer in the registry.

**5. Separate failure: stream dropouts.** The unlabelled snapshot (08:09) shows pulse gaps of up to
1.4 s; a gap over 250 ms leaves the CNN without inputs for 11 s, so it scored nothing at all.

**What is left.** About four held, fairly still pinches in session 1 peak at 0.64–0.92, under the
0.99 threshold, with no single cause found.

## Implications

- The offline result (47/57, resting arm, held pinches about 6 s apart) does not describe live use.
  The training and evaluation data need sessions that look like the real task: pinch, hold, **turn**,
  release; quicker pinching; some taps if taps should count; arm not resting.
- Decide whether a quick tap should fire. A grab needs a hold anyway, so taps could be out of scope,
  but then the UI should say so.
- Any lower threshold must be checked on everyday-noise recordings first: these snapshots contain
  almost nothing but pinches, so they cannot measure false activations.
- Use the miss recorder in **Live** mode next time, and mark only after the volume fails to respond,
  so marks and live behaviour line up.

## Threshold sweep on unseen data (14 Nov)

Model `pinch_in-ae0a22bf` (active), replayed with the trainer at `c924661` over every recording that
shares no sensor stream with its 20 training recordings (`inventory.py`, `sweep.py`): 43 distinct
streams exist, 23 are unseen. Overlapping miss windows were reduced to three whose scored spans do
not overlap. No-gesture exposure: 0.64 h in total, of which only **0.17 h is everyday activity**
(one 10-minute recording); still/supported 0.23 h, gaps inside pinch sessions 0.24 h.

| Activation | Pinch sessions | Live misses | False activations | Rate |
|---|---|---|---|---|
| **0.99** (current) | 108/178 | 17/30 | 2 | 3.1/h |
| 0.97 | 110/178 | 20/30 | 3 | 4.7/h |
| 0.95 | 113/178 | 20/30 | 5 | 7.8/h |
| 0.90 | 117/178 | 20/30 | 8 | 12.5/h |
| 0.85 | 122/178 | 20/30 | 8 | 12.5/h |

False activations at 0.99 fall in unlabelled time inside pinch sessions; from 0.95 the everyday-noise
recording starts to fire too (1, then 2).

**Conclusion at the time: keep 0.99** (superseded by the rerun below). Going to 0.90 buys 9 pinch-session catches (+5%) and 3 live ones for four
times the false activations, and the everyday exposure is far too short to measure that cost
reliably: zero events in 0.17 h only bounds the everyday rate below 18/h.

**The bigger problem is per-session recall**, which ranges from 17/18 to 3/19 at the same threshold.
Unseen 9 Nov sessions: 58/102. The worst, 9 Nov 12:00 (3/19), has strong wrist motion before and
during each pinch (median 0.37 and 1.35 rad/s, against 0.01 and 0.44 in training), the same pattern
as the live misses. The other 3/19 session (4 Nov, `new/`) is still but carries only the original
automatic labels, so part of it may be label timing rather than real misses.

**To set a threshold properly**: wear the watch for 1–3 h of normal work with the app in Monitor
mode (zero false events in 3 h bounds the rate below 1/h), then repeat this sweep on that recording.

## Rerun with 47 minutes of everyday noise (14 Nov)

Two Recorder sessions of everyday activity on 14 Nov (`gesture-dataset-unlabeled-2026-11-14T09-58-34.967Z`, 20 min,
and `…T10-29-35.618Z`, 27 min; every row labelled `everyday_noise`, 100 Hz motion, one 0.57 s gap) were added. They
share no stream with the training data. Everyday exposure goes from 0.17 h to 0.94 h. The sweep groups everyday noise by
label now, because these exports are named "unlabeled". Same model, trainer and matching as above; the other columns
are unchanged.

| Activation | Pinch sessions | Live misses | Everyday false activations | Everyday rate |
|---|---|---|---|---|
| 0.999 | 100/178 | 10/30 | 3 | 3.2/h |
| 0.998 | 105/178 | 11/30 | 6 | 6.4/h |
| 0.995 | 107/178 | 14/30 | 13 | 13.8/h |
| **0.99** (current) | 108/178 | 17/30 | 20 | **21/h** |
| 0.95 | 113/178 | 20/30 | 33 | 35/h |
| 0.90 | 117/178 | 20/30 | 43 | 46/h |

**The earlier 3.1/h was an artefact of too little everyday data.** The older 10-minute recording had no events; the
two new ones have 11 and 9 at 0.99, so in ordinary use the current model would fire about once every three minutes.
Lowering the threshold is ruled out.

**What fires** (`false_events.py`, `false_events.json`): in 19 of the 20 events the wrist is calm in the 1.3 s before
(median 0.057 rad/s) and then makes a short movement (peak 0.2–1.6 rad/s); one is inside a large swing. That is the shape
of the training pinches (rest, then a small event), so the model has learned "still, then a twitch", not a pinch. Peaks
sit just over the line (0.991–1.000), which is why a stricter threshold removes them quickly.

**No threshold fixes this.** 0.998 cuts everyday events by 70% (20 → 6) for 3 pinch-session catches, but the live-style
pinches, already the weak case, fall from 17/30 to 11/30. The model separates the two classes too poorly near the top of
its range.

**Next:** retrain with these two recordings as negatives (hard everyday negatives), together with real-task pinches
(pinch, hold, turn, release, natural pace), and keep part of the everyday data back for testing, since the recordings
used here become training data. Then repeat this sweep on held-out everyday noise. If a stop-gap is wanted before that,
0.998 trades live recall for far fewer false events. It is a choice of failure, not a fix.

## Retrain with the new noise as hard negatives (14 Nov)

Two CNNs trained with the current trainer (100 Hz, median/MAD scaling over 11 s), same seed (17), negatives and
`hardNegatives` as `ae0a22bf`, same 8 evaluation recordings (`retrain-2026-11-14/`, specs and bundles kept):

- **A, baseline:** `ae0a22bf`'s 20 training recordings only (`pinch_in-ebb19d77`), to separate the trainer change from the data.
- **B, + noise:** the same plus the 20-minute noise recording `…T09-58-34.967Z` (`pinch_in-46889d12`).

Both are scored on the held-out set none of the three models trained on (`compare.py`): unseen pinch sessions, the three
non-overlapping live windows, and as everyday test the 27-minute `…T10-29-35.618Z` plus the older 10-minute recording
(0.61 h). Trainer-chosen activation is 0.99 for all three.

| Model, activation | Pinch sessions | Live-style | Everyday false activations |
|---|---|---|---|
| `ae0a22bf` (active), 0.99 | 108/178 | **17/30** | 9 (14.8/h) |
| A baseline, 0.99 | 116/178 | 2/30 | 4 (6.6/h) |
| B + noise, 0.99 | 99/178 | 4/30 | **0** (95% upper 4.9/h) |
| B + noise, 0.95 | 109/178 | 5/30 | 1 (1.6/h) |
| B + noise, 0.90 | 112/178 | 7/30 | 1 (1.6/h) |

**The hard negatives work.** Against A, B removes every held-out everyday false activation at 0.99, at the cost of 17
pinch-session catches; at 0.95 it matches `ae0a22bf` on pinch sessions (109 vs 108) with one ninth of the everyday false
activations.

**But the current trainer loses the live-style pinches.** A, trained on exactly `ae0a22bf`'s data, catches 2/30 live-style
pinches against 17/30, so the drop comes from the trainer, not from the noise (investigated below).

**Not deployed.** B would cut false activations in everyday use but miss most pinches made the way they are made live.
`ae0a22bf` stays active. Next: confirm the scaling hypothesis on the live windows, then record real-task sessions and
retrain with them plus these hard negatives, so the training data has the live pinches the trainer is now failing on.

## Why the current trainer loses live-style pinches (14 Nov)

Correction: `ae0a22bf` was not trained on rolling z-scores. Its manifest kind is `ppg_imu_cnn_median` and its trainer
(`c924661`, 8 Nov) scales each channel by the median and MAD of the 11 s history, at 50 Hz, with nothing left out (its
pipeline text is stale). Since then the trainer has gained the moving-wrist exclusion (`f717bca`, 9 Nov), staged training
(`87dccaf`), a tighter training budget (`0a0ffb3`) and 100 Hz inputs (`c1b5815`).

**Ruled out** (`per_start.py`, `density.py`, `ablate.py`, `peak_timing.py`):

- *Pinches filling the history.* A misses live pinches with no earlier pinch in their 11 s (peak 0.45) and the live
  windows' history spread (median 0.015 rad/s) is within that of the sessions A handles.
- *Pulse.* Setting the three pulse channels to neutral moves A's live catches from 2 to 4 of 30. Both models lean on the
  accelerometer (neutral accelerometer: 0/30 live, 19/180 sessions).
- *Timing.* A peaks where `ae0a22bf` does, about 400 ms after the start, inside the match window; the peaks are lower
  (median 0.40 against 0.99).
- *The moving-wrist exclusion at scoring time.* Scoring the current-trainer models with it switched off leaves live-style
  recall at 3/30 (A), 1/30 (seed 18), 7/30 (50 Hz), 4/30 (B).

**Variants of A, same data and spec** (held-out set, activation 0.99; `retrain-2026-11-14/`):

| Trainer | Pinch sessions | Live-style | Everyday false activations |
|---|---|---|---|
| `c924661` (`ae0a22bf`) | 108/178 | **17/30** | 9 |
| current, 100 Hz, seed 17 (A) | 116/178 | 2/30 | 4 |
| current, 100 Hz, seed 18 | 105/178 | 1/30 | 2 |
| current, 50 Hz | 121/178 | 7/30 | 3 |
| current, 100 Hz, rolling z-score (patched) | 107/178 | 12/30 | 2 |

The two seeds agree, so this is not one unlucky run. The 100 Hz grid and the median scaling each cost live recall
(50 Hz recovers 5, rolling recovers 10), while pinch sessions stay at 105–121. The models are learning the resting-arm
pinch more narrowly, which suits the sessions and fails on live use.

**Still open:** the current trainer at 50 Hz (7/30) is far from `ae0a22bf` (17/30), so part of the loss lies in the other
training changes, or in `ae0a22bf` being a lucky draw. The next check is to retrain with `c924661` itself (two seeds):
if it reproduces about 17/30, bisect `f717bca`, `87dccaf` and `0a0ffb3`.
