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
