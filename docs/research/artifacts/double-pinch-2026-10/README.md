# Double pinch with the motion sensors — October 2026

Is a double pinch (two quick thumb-to-index pinches) detectable mainly from the watch's motion sensors, with the pulse
sensor only as a reference?

## Step 1: does a contact show in the motion sensors? (2026-10-31)

`imu_contact_check.py` → `imu-contact/`. In 21 Recorder recordings with camera hand tracking, 743 moments the thumb and
index closed (camera, on the watch clock) and 738 releases each give a sharp jolt in the accelerometer and gyroscope (each
axis less its 0.3 s moving mean): a peak about 0.1-0.15 s after the camera's contact, 4-5 times the recording's typical
level, about a quarter of a second wide, clear in 95% of recordings' own averages (35% for random moments). One contact at
a time, the largest jolt within 150 ms tells contacts from random moments with an AUC of 0.769 (accelerometer) and 0.729
(gyroscope), and releases alike (0.762, 0.730), at 50 Hz.

So each contact is visible on its own; a release looks the same, so a double pinch is a pattern of jolts. The random
moments come from the same calm pinch sessions: whether the pattern stands out from everyday activity needs new data
(step 2). The camera and watch clocks line up to within about 94 ms, which widens the averaged peak. The recordings are the
app's own (its data folder), not in the repository; `CAMERA_RECORDINGS` points the script elsewhere.

## Step 2a: what the repository's recordings say (2026-10-31)

`repo_datasets_check.py` → `repo-datasets/`. The 47 usable recordings in `data/recordings/` (one left out for a broken
clock) hold 490 single pinches, other gestures and 11 minutes of everyday time, but no double pinch. With a fixed
threshold on the jolt (accelerometer and gyroscope averaged):

* A pinch is found (a jolt peak from 0.5 s before to 1.0 s after its labelled start) more often than the same window
  in everyday time, but not by much: 85% against 56% at a threshold of 3 spreads, 68% against 42% at 5. The labels are
  late and loose, which blurs this; the camera-timed contacts of step 1 are the sharper measure.
* Both pinches of a real pair are found about as often as one pinch's chance squared (76% against 72% at 3), so the
  pinches of a pair behave independently.
* The double-pinch rule (two peaks 0.15-0.6 s apart, quiet for 0.5 s either side) fires 1.3-1.9 times a minute in
  everyday time at every threshold, on 5-18% of single pinches and on 6-20% of fists, hand opens and thumbs ups.

So a fixed threshold on the jolt is far from a usable double-pinch detector: about 90 false triggers an hour, against a
target of one or fewer. The jolt is there, but so are many like it. A detector needs the jolts' shape and their pattern
together, learned from real double pinches against real everyday activity. These recordings can't supply that: they
have no double pinches, and their everyday time is mostly resting between cues. Recording double pinches (step 2) is
still needed; these recordings remain useful as negatives.

## Step 2b: is the jolt sharper in one arm pose? (2026-10-31)

`orientation_check.py` → `orientation/`. The watch's rotation vector gives the direction of "up" in its axes at each of
the 490 pinches. Over all pinches, those with the forearm upright have a much smaller jolt (accelerometer 0.14 m/s²,
4× the stillness before) than those with the arm flat, face up (0.74 m/s², 7×) or on its side (0.77 m/s², 7×). But all 74
upright pinches come from seven recordings made on 11 October, when pinches were weak in every pose. Within the five
recordings that hold pinches in two poses, neither pose is consistently stronger (accelerometer 0.076 against 0.087 and
0.182 against 0.175 upright against flat; 0.51-0.86 against 0.69-0.75 on its side against flat). So the difference over
all pinches follows the session (strap, pinch firmness, day), not the pose; a smaller pose effect is not ruled out.

To settle it, a guided session should change pose within the session (flat on the desk, hanging, raised) with the same
strap and pinch. If pose matters, the model can take the orientation as an input, or scale each jolt to the recent motion
rather than to a fixed threshold.

## Step 3: which model finds a contact? (2026-10-31)

`imu_models_check.py` → `imu-models/`. Each model sees the last 1.0 s of motion (linear acceleration and gyroscope at
50 Hz) every 40 ms and marks pinch contacts, trained on the camera's contacts in 14 pinch recordings (278 contacts, only
those inside a labelled pinch: the camera also "closes" the fingers in fists and everyday movement) against 14
recordings with no pinch. Share of contacts found at 1 false alarm a minute:

| Model | Recordings held out | A recording day held out |
|---|---:|---:|
| jolt threshold (no training) | 4% | 3% |
| logistic regression | 8% | 6% |
| ExtraTrees | 60% | 19% |
| gradient boosting | 42% | 11% |
| random convolutions (ROCKET-style) | 35% | 18% |
| 1D CNN | 64% | 27% |
| 1D CNN + orientation | 64% | 14% |

* Non-linear models are far ahead: the linear model and the fixed threshold barely work at a low false-alarm rate (their
  window AUCs, 0.85-0.88, hide that). The CNN and ExtraTrees lead; a double pinch would be found about 40% of the time.
* A new session is the problem: on a day not trained on, the best (the CNN) finds 27%. With two camera days there is too
  little variety. The orientation channels help within sessions at strict rates (46% against 29% at 0.2 a minute) but
  hurt on a new day, where the poses differ.
* On the guided sessions of 2026-10-31 (rest between cues, and in one of them typing, mouse use and arm movement at
  the end), the highest score near a labelled pinch beats random windows clearly (AUC 0.89 for the CNN with orientation, 0.91 gradient boosting, 0.99 the
  jolt over its recent 10 s level): the pinch stands out from that activity. On the 11 October sessions, whose pinches
  were weak (step 2b), no model beats chance. Pooled together the AUCs fall below 0.5 only because the sessions' score
  levels differ.

One seed per model, and 278 contacts, so differences of a few points are noise. Next: more sessions across days
(the double-pinch guided sessions), and scaling each window to the recent motion level, which made the plain jolt work
on the guided sessions, as an input to the CNN.

## Step 4: conditions and checks around the model (2026-10-31)

`conditions_check.py` → `conditions/`. Each candidate rule is set to keep 98% of the 278 camera-timed pinches, and
scored by how much of each everyday activity it removes. The conditions, the rules and what to do next are in
[Double pinch: the conditions it works in](../../double-pinch-conditions-2026-10.md). In short: gating on arm movement
(acceleration RMS over the last second) removes 88% of arm-movement time, and gating on wrist turning removes 69%. Rejecting jolts
that are too large, too soft or not about the pinch's gyroscope axis removes most of what is left there. Typing and
mouse use keep about 20 candidate jolts a minute, so the double-pinch pattern and the model still decide. The 120 ms
cue buzz barely shows at 50 Hz.

## Step 5: detect only inside steady motion (2026-11-01)

`stability_check.py` → `stability/`. The rule: detection is on only while the motion is steady. Steady means a small
acceleration spread, slow turning, and little tilt change over the second before the first contact, and again after
the second release. With limits of 0.4 m/s², 0.5 rad/s and 10°, requiring steadiness on both sides leaves 7% of
arm-movement time open, 8% of twisting and 12% of typing. It keeps 64% of the recorded pinches; many of them were made
while the arm was still settling, and nobody was asked to hold still. Mouse use, fists and thumbs-ups are steady too,
so steadiness is the condition for looking, not the evidence of a pinch. It is rule B0 in the
[conditions document](../../double-pinch-conditions-2026-10.md).

## Step 6: a high-pass filter on the shake (2026-11-01)

`filter_check.py` → `filter/`. Causal high-pass filters are compared on the camera-timed pinches and the everyday
activities, with the threshold set to keep 95% of pinch peaks. A Butterworth filter, order 2 at 8 Hz, on the
accelerometer cuts wrist-twist candidates from 40 to 4 a minute and thumbs-up candidates from 11 to 3, and lifts a pinch
from 5.9× to 7.4× over the motion before it. It does not help with typing, mouse use or arm movement, which shake in
the same band. A pinch's power keeps rising against other motion up to 25 Hz, the limit at 50 Hz, so 100 Hz should
separate better. It is rule C0 in the [conditions document](../../double-pinch-conditions-2026-10.md).

## Step 7: a CNN on the spike and a little around it (2026-11-01)

`spike_cnn_check.py` → `spike-cnn/`. Each candidate spike in the 8 Hz high-passed shake gets a window centred on it, and
a CNN learns whether it is a pinch. Windows of ±0.1 s, ±0.2 s and ±0.5 s are compared, high-passed and unfiltered; the
scores are the average of 5 training runs. With whole recordings held out, at 1 false alarm a minute:

* The high-passed ±0.2 s window found 51% of contacts. On the typing and mouse use it never trained on, it fired 1.0
  and 0.0 times a minute, against 90 and 72 candidate spikes a minute. Spike shape does separate taps, at this
  strict setting.
* The spike alone (±0.1 s) did worse: 45%, and 5 a minute in typing.
* The unfiltered ±0.2 s window found the most: 72% of contacts, and 24% against 14% on a held-out day. The high-pass
  removes something slow in the pinch that the CNN uses. It fired 2.7 times a minute in mouse use.
* On a held-out day, every variant found 24% or less. A new session is still the main problem.
* The context rules (B0, B4) removed all the arm-movement false alarms, but only 187 of the 246 contacts with a spike
  pass them in these recordings.

The samples are small: 241 pinch spikes and 316 other spikes to train on, and about a minute each of typing, mouse use
and arm movement.

## Step 8: scaling each axis to 0-1 before the spike CNN (2026-11-01)

`normalize_cnn_check.py` → `normalize-cnn/`. The same candidates, ±0.2 s windows, folds and CNN as step 7. Each
pipeline runs the same way in training and testing, using only past samples. Contacts found at 1 false alarm a minute:

| Pipeline | Recordings held out | Day held out |
|---|---:|---:|
| raw, high-passed (step 7) | 51% | 14% |
| raw (step 7) | 72% | 24% |
| z-score over the trailing 10 s, sigmoid, high-pass | 56% | 33% |
| **z-score over the trailing 10 s, sigmoid** | 67% | **42%** |
| z-score, high-pass | 56% | 27% |
| min-max over the trailing 10 s, high-pass | 56% | 29% |

Scaling each axis by its own recent level is the biggest gain on a new day so far: 24% → 42% without the high-pass,
14% → 33% with it. It also finds the most pinches at the strictest setting (33% at 0.2 false alarms a minute, against
17%). The high-pass still costs the CNN pinches. On the typing and mouse use it never saw, z-score + sigmoid fired 0 and
1.3 times a minute; arm movement fired 6.7 times a minute, and none behind the context rules. The samples are as small
as in step 7.

## The watch's rate ceiling, and the literature (2026-11-01)

The Galaxy Watch4 offers apps at most 100 Hz on every motion sensor, and the app already receives 100 Hz. The papers
with the highest pinch accuracy sampled at 400-4000 Hz. The closest match at 100 Hz, ViWatch, reached its accuracy by
adapting to each new user. Both are written up in the
[conditions document](../../double-pinch-conditions-2026-10.md#the-watchs-limits-and-what-published-systems-did).
