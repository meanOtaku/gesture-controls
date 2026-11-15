# Rewrite: `sections/07-discussion.tex`

Rewrite any block below in your own words. See [the guide](README.md) for the few things to keep (citations, references, maths). Blocks left empty keep their current text.

## Discussion

### What the implemented system establishes

<!-- block 07-discussion/p001 -->
#### ¶ p001 · **report version** (long)

**Current:**

> For RQ1, the design keeps brief recognition events apart from the ongoing interaction state and from the output. This matters in practice: if the release pinch is missed, the head leaving the target or a stale signal still ends the grab, so the system does not keep changing the volume. A designed safeguard is not a measured failure rate, though. We have not yet measured target-selection error, task time, unintended commands, cancellation latency or any accessibility benefit across users.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p001 -->

<!-- block 07-discussion/p002 -->
#### ¶ p002 · **papers version** (short)

**Current:**

> For RQ1, keeping recognition events apart from the interaction state means a missed release does not leave the volume changing: the head leaving the target or a stale signal still ends the grab. We have not yet measured target-selection error, task time or unintended commands.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p002 -->

<!-- block 07-discussion/p003 -->
#### ¶ p003 · **report version** (long)

**Current:**

> The audit also exposed a reproducibility problem that is easy to fall into. A re-exported recording looks like a new session, and corrections disappear when a script reads the old label column. Hashing the sensor streams and storing both label versions makes these problems visible. Finding no duplicate across the hand-labelled split is reassuring, but it does not rule out every kind of leakage.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p003 -->

<!-- block 07-discussion/p004 -->
#### ¶ p004 · **papers version** (short)

**Current:**

> The audit also shows how easily a dataset can mislead. A re-exported recording looks like a new session, and corrections vanish when a script reads the old label column; hashing streams and storing both label versions makes this visible.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p004 -->

### Prospects for AR and VR

<!-- block 07-discussion/p005 -->
#### ¶ p005 · **report version** (long)

**Current:**

> Nothing in the detection pipeline depends on the laptop. The detector sees only watch signals, and head orientation is also available from any AR/VR headset. In principle, the same pinch-in and pinch-out events could confirm and release a selection made by head or eye direction inside a headset. The wrist sensor would add most where camera hand tracking struggles: hands out of the cameras' view, hands occluded by objects, poor lighting, or interfaces where running the hand-tracking cameras just to detect a pinch costs too much power. It could also work alongside camera tracking, filling the gaps when the hand leaves the view.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p005 -->

<!-- block 07-discussion/p006 -->
#### ¶ p006 · **papers version** (short)

**Current:**

> Nothing in the detection pipeline depends on the laptop: the detector sees only watch signals, and AR/VR headsets provide head orientation. The same pinch events could confirm a head- or gaze-directed selection in a headset, and would help most where camera hand tracking struggles: hands out of view or occluded, poor lighting, or when running cameras just to detect a pinch costs too much power.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p006 -->

<!-- block 07-discussion/p007 -->
#### ¶ p007 · **report version** (long)

**Current:**

> These are possibilities, not findings. We have not run the system in a headset. Head movement in immersive use is larger and faster than at a desk, which may change both targeting and how much arm motion the detector has to reject. A pinch sensed at the wrist also gives no visual feedback of the hand unless the application adds it. The false-activation and latency results reported here would need to be measured again under those conditions.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p007 -->

<!-- block 07-discussion/p008 -->
#### ¶ p008 · **papers version** (short)

**Current:**

> These are possibilities, not findings. Immersive use involves larger head movements and more arm motion, so the false-activation and latency results would need to be measured again in a headset.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p008 -->

### Annotation changes versus learning improvements

<!-- block 07-discussion/p009 -->
#### ¶ p009 · **report version** (long)

**Current:**

> If scores improve after relabelling, there are two possible reasons: the reference labels became more accurate, or the model was retrained differently. Often both happen at once. Two analyses can separate them. The first rescores the same frozen predictions against the original and the corrected labels. The second trains a model on each label version with the same source groups and selection procedure. A single before-and-after number cannot tell the two effects apart.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p009 -->

<!-- block 07-discussion/p010 -->
#### ¶ p010 · **papers version** (short)

**Current:**

> If scores improve after relabelling, either the labels became more accurate or the model was retrained differently, and often both. Rescoring the same frozen predictions against each label version, and training one model per label version on the same split, would separate the two effects. Manual review is itself a measurement: an independent reviewer should label a pre-chosen sample, because relabelling while looking at a model's own false alarms biases the result toward that model.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p010 -->

<!-- block 07-discussion/p011 -->
#### ¶ p011 · **report version** (long)

**Current:**

> Manual review is itself a measurement, with its own error. The definitions of contact and release, camera visibility, frame timing, clock alignment and the handling of disagreements should all be written down. Relabelling while looking at a model's own false alarms can bias the result toward that model. An independent reviewer should label a pre-chosen sample, and ambiguous or excluded stretches should be reported rather than dropped.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p011 -->

### Why zero observed events is not all-day reliability

<!-- block 07-discussion/p012 -->
#### ¶ p012 · **report version** (long)

**Current:**

> Seeing zero false activations does not mean the true rate is zero. If false events follow a constant-rate Poisson process, observing none in \(T_h\) eligible hours gives a one-sided 95% upper bound of \(-\ln(0.05)/T_h\) [cite:garwood1936poisson], the basis of the “rule of three” for zero counts [cite:hanley1983zero]. Real activities and people are not that uniform, so this is an approximation. With 0.48 eligible hours, the upper bound is 6.2 false activations per hour, which is far from all-day reliability.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p012 -->

<!-- block 07-discussion/p013 -->
#### ¶ p013 · **papers version** (short)

**Current:**

> Finally, zero observed false activations does not mean a zero rate. Under a constant-rate Poisson model, observing none in \(T_h\) hours gives a one-sided 95% upper bound of \(-\ln(0.05)/T_h\) [cite:garwood1936poisson,hanley1983zero]; for 0.48\,h that is 6.2 per hour, far from all-day reliability.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p013 -->

<!-- block 07-discussion/p014 -->
#### ¶ p014 · **report version** (long)

**Current:**

> Likewise, overlapping windows are not independent samples, and training seeds are not extra participants. A population-level interval needs participants as the sampling unit; a personalised study needs repeated sessions. For an interface whose errors can happen at bad moments, the worst condition matters as much as the pooled result.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 07-discussion/p014 -->
