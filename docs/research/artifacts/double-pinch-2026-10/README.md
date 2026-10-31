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
