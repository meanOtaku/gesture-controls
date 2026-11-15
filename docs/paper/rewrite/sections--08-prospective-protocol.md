# Rewrite: `sections/08-prospective-protocol.tex`

Rewrite any block below in your own words. See [the guide](README.md) for the few things to keep (citations, references, maths). Blocks left empty keep their current text.

## Prospective Validation Protocol

## Future Work

<!-- block 08-prospective-protocol/p001 -->
#### ¶ p001 · **report version** (long)

**Current:**

> This section describes planned work; none of these experiments has been run yet. The first step is to freeze everything that affects the result: model files, label versions, source groups, exclusions, thresholds, matching rules and how unavailable input is counted. Before any headline comparison, the full event logs for the current model and the pinch-out data should be recovered.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 08-prospective-protocol/p001 -->

<!-- block 08-prospective-protocol/p002 -->
#### ¶ p002 · **papers version** (short)

**Current:**

> Three studies come next; none has been run yet. First, with models, labels and thresholds frozen in advance, compare IMU-only, PPG-only and fused inputs, rolling against median scaling, and the CNN against engineered-feature trees on the same corrected data. Second, test generalisation with multiple participants across new days and strap refits, holding out whole participants for user-independent claims. Third, run a counterbalanced task comparing look–pinch–turn with a conventional volume control, with fault trials and a latency breakdown, and repeat the selection task inside an AR/VR headset, comparing its camera pinch, the watch pinch and both combined.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 08-prospective-protocol/p002 -->

🖼️ *[figure fig-prospective, kept as it is]*

<!-- block 08-prospective-protocol/c003 -->
#### 🏷️ caption c003 · **report version** (long)

**Current:**

> Planned confirmatory workflow: develop, freeze, collect new data, then evaluate continuously and in live use. None of these stages has been carried out yet.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 08-prospective-protocol/c003 -->

### Matched sensing and preprocessing comparisons

<!-- block 08-prospective-protocol/p004 -->
#### ¶ p004 · **report version** (long)

**Current:**

> The smallest useful ablation compares IMU-only, PPG-only and fused inputs on the same corrected source groups, then rolling against median scaling, then the CNN against the engineered-feature trees. All variants should share the selection procedure, false-activation target, input rate, exclusions and matching rules. Each may have its own threshold, chosen the same way on development data and never on test data. Synthetic splices are useful, but real pinches after real movement should be tested as well.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 08-prospective-protocol/p004 -->

### Personalisation and generalisation

<!-- block 08-prospective-protocol/p005 -->
#### ¶ p005 · **report version** (long)

**Current:**

> Different claims need different splits. A personalised claim needs each person's frozen model tested on new days and after the strap is refitted. A user-independent claim needs whole participants held out. Few-shot adaptation needs a calibration block kept separate from the later test. The number of participants and the amount of exposure should be set from pilot variation and the precision we want. New sessions should include ordinary keyboard and mouse use, wrist turns, different arm support and strap fit, and the quiet conditions the interaction assumes. Pinching while the hand moves should be reported separately if it falls outside the intended still-hand use.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 08-prospective-protocol/p005 -->

### Interaction and physical fault trials

<!-- block 08-prospective-protocol/p006 -->
#### ¶ p006 · **report version** (long)

**Current:**

> A counterbalanced task should compare look–pinch–turn with a conventional volume control, using set practice, target and timeout rules. We would measure completion time, final error, retries, missed grabs and releases, unintended actions, and discomfort and workload. Fault trials should cover stale signals, disconnection and reconnection, the head leaving the target, model replacement and a release while a volume write is still queued. Latency should be broken down into sensing, receipt, scoring, event emission, policy acceptance and the completed output, with clock uncertainty and unavailable intervals reported.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 08-prospective-protocol/p006 -->

### Testing in a headset

<!-- block 08-prospective-protocol/p007 -->
#### ¶ p007 · **report version** (long)

**Current:**

> A natural next step is to repeat the selection task inside an AR or VR headset, using the headset's own head or eye tracking for targeting and the watch for pinch-in and pinch-out. Useful comparisons would be the headset's built-in camera pinch alone, the watch pinch alone, and both combined, including trials with the hand deliberately kept out of the cameras' view. The same event-level measures (recall, false activations per hour of no-gesture time, latency) would let the results be compared directly with the desktop study.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 08-prospective-protocol/p007 -->
