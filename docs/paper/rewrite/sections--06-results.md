# Rewrite: `sections/06-results.tex`

Rewrite any block below in your own words. See [the guide](README.md) for the few things to keep (citations, references, maths). Blocks left empty keep their current text.

## Results

### Later hand-labelled development artifact

<!-- block 06-results/p001 -->
#### ¶ p001 · **report version** (long)

**Current:**

> The hand-labelled model is [url:pinch_in-ae0a22bf], SHA-256 [url:ae0a22bf8f744d5fa2fce9208221f0947288c5ba5c5eb196180985a70d77ba0d]. Its bytes match the manifest, as do those of all seven model files in the project. This confirms the files are intact; it does not tell us which model is running on any given laptop.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p001 -->

<!-- block 06-results/p002 -->
#### ¶ p002 · **papers version** (short)

**Current:**

> We evaluate the hand-labelled pinch-in model [url:pinch_in-ae0a22bf], whose file matches its declared SHA-256. Its threshold was chosen on the training recordings, not on the evaluation set, and its stored window ROC AUC is 0.982.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p002 -->

<!-- block 06-results/p003 -->
#### ¶ p003 · **report version** (long)

**Current:**

> The manifest records a window ROC AUC of 0.981993, balanced accuracy of 0.881720 and window F1 of 0.865854, together with an event recall of 0.824561 and no false activations. The threshold was chosen on the training recordings ([url:thresholdChosenOnEvaluationRecordings] is false). That is a stronger separation than tuning on the evaluation set, but the evaluation recordings may still have influenced label edits, architecture choices or which candidate model was kept.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p003 -->

🖼️ *[table, kept as it is]*

<!-- block 06-results/c004 -->
#### 🏷️ caption c004 · **report version** (long)

**Current:**

> Stored manifest fields for the pinch-in model. The event values were reproduced by replay. These are development results, not a prospective test.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/c004 -->

<!-- block 06-results/p005 -->
#### ¶ p005 · **report version** (long)

**Current:**

> The model was saved without its event log, so we recovered it by replay. The exact training specification was not saved either. We rebuilt the label roles from the project's documented defaults and tried all four combinations of the two uncertain settings (whether [url:left_out] is excluded, and whether the still-hand rule applies); all four gave the same result. Running the stored model over the eight evaluation recordings with the trainer's own input building, detection rule and event accounting reproduced the stored metrics exactly (Table [ref:tab-replay]).

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p005 -->

<!-- block 06-results/p006 -->
#### ¶ p006 · **papers version** (short)

**Current:**

> The model was saved without its event log, so we recovered it by replaying the stored model over its eight evaluation recordings with the trainer's own code. This reproduced the stored metrics exactly (Table [ref:tab-replay]).

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p006 -->

🖼️ *[table tab-replay, kept as it is]*

<!-- block 06-results/c007 -->
#### 🏷️ caption c007

**Current:**

> Replayed event outcomes of the hand-labelled pinch-in model on its eight evaluation recordings.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/c007 -->

<!-- block 06-results/p008 -->
#### ¶ p008 · **report version** (long)

**Current:**

> Figure [ref:fig:score-timeline] shows how this looks over time for one evaluation recording, the pinch-hold session of 4 November. Of its 21 annotated starts, 17 were caught. The other four show three different ways a pinch can be missed. One produced no response at all. One raised the score to 0.906, short of the 0.99 activation threshold. The remaining two produced an event about 280\,ms after the start, just before the 300\,ms match window opens, so they count as outside the match window. Between pinches the score stays close to zero, and the recording has no false activations. Figure [ref:fig:latency] shows the latencies of all 47 caught starts across the eight recordings: most fall between 350 and 550\,ms, with a tail up to 755\,ms.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p008 -->

🖼️ *[figure fig:score-timeline, kept as it is]*

<!-- block 06-results/c009 -->
#### 🏷️ caption c009 · **report version** (long)

**Current:**

> Score of the hand-labelled pinch-in model over the evaluation recording [url:gesture-dataset-pinch_hold-2026-11-04T04-50-33.518Z], replayed with the trainer's own detection rule. Shaded bands are annotated pinch gestures; markers below the axis are annotated starts, markers above are emitted events. The grey region in the top panel is shown in detail below.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/c009 -->

🖼️ *[figure fig:latency, kept as it is]*

<!-- block 06-results/c010 -->
#### 🏷️ caption c010 · **report version** (long)

**Current:**

> Latency from the annotated start to the emitted event for the 47 caught pinch-in starts in the eight evaluation recordings (25\,ms bins). The shaded region is the 300–900\,ms match window.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/c010 -->

<!-- block 06-results/p011 -->
#### ¶ p011 · **papers version** (short)

**Current:**

> Fig. [ref:fig:score-timeline] shows one evaluation recording over time. Of its 21 annotated starts, 17 were caught. The four misses failed in different ways: one produced no response, one raised the score to 0.906, short of the threshold, and two fired about 280\,ms after the start, just before the match window opens, so they fall outside it. Between pinches the score stays close to zero.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p011 -->

🖼️ *[figure fig:score-timeline, kept as it is]*

<!-- block 06-results/c012 -->
#### 🏷️ caption c012 · **papers version** (short)

**Current:**

> Score of the hand-labelled pinch-in model over one evaluation recording (pinch-hold session, 4 November), replayed with the trainer's detection rule. Shaded bands are annotated pinches; markers below the axis are annotated starts and markers above are emitted events. The grey region of the top panel is shown in detail below.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/c012 -->

<!-- block 06-results/p013 -->
#### ¶ p013 · **report version** (long)

**Current:**

> Latency is measured from the annotated start to the moment the event is emitted. The margin behind the zero false-activation count is thin. In the everyday-activity recording the highest score reached 0.970, just under the 0.99 threshold; lowering the threshold to 0.98 would have added one false activation, and 0.95 would have added two. We report this as a sensitivity check, not as a reason to pick a different threshold.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p013 -->

<!-- block 06-results/p014 -->
#### ¶ p014 · **papers version** (short)

**Current:**

> The margin behind the zero false-activation count is thin. In the everyday-activity recording the highest score reached 0.970 against the 0.99 threshold, and thresholds of 0.98 and 0.95 would have added one and two false activations.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p014 -->

<!-- block 06-results/p015 -->
#### ¶ p015 · **report version** (long)

**Current:**

> There is no hand-labelled pinch-out model. A median pinch-out model exists, but its training data cannot be traced, so it is not a matched counterpart. The result above therefore covers pinch-in only, not the full grab-and-release interaction.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p015 -->

<!-- block 06-results/p016 -->
#### ¶ p016 · **papers version** (short)

**Current:**

> There is no matched hand-labelled pinch-out model, so these results cover pinch-in only.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p016 -->

### Historical camera-label transfer

<!-- block 06-results/p017 -->
#### ¶ p017 · **report version** (long)

**Current:**

> The best historical configuration, trained on camera labels with noise recordings and without a still-hand gate and evaluated leave-one-day-out, caught 161 of 372 pinch-in starts (43.3%). It produced seven false activations per hour on noise recordings and 49 per hour during no-gesture time inside pinch recordings. These rates use different denominators and should not be averaged.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p017 -->

<!-- block 06-results/p018 -->
#### ¶ p018 · **papers version** (short)

**Current:**

> An earlier configuration trained on camera labels caught 161 of 372 pinch-in starts (43.3%) under leave-one-day-out evaluation, with seven false activations per hour on noise recordings and 49 per hour within pinch recordings. Recall ranged from 21 of 171 on 14 October to 67 of 92 on 3 November (Fig. [ref:fig-historical]), a spread that a pooled number hides.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p018 -->

<!-- block 06-results/p019 -->
#### ¶ p019 · **report version** (long)

**Current:**

> Performance varied widely by day: 21 of 171 on 14 October, 37 of 52 on 17 October, 67 of 92 on 3 November and 36 of 57 on 4 November (Fig. [ref:fig-historical]). The later days support the earlier statement that the model catches about two thirds of unseen pinches; the pooled result does not. An earlier result of 204 of 372 came from a model trained on many October sessions and is not a clean October holdout.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p019 -->

🖼️ *[figure fig-historical, kept as it is]*

<!-- block 06-results/c020 -->
#### 🏷️ caption c020

**Current:**

> Historical camera-label results, leave-one-day-out. Bars show caught/eligible starts per day; the dashed line is the pooled 161/372. False-activation rates use each condition's own no-gesture time. All days come from one participant.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/c020 -->

<!-- block 06-results/p021 -->
#### ¶ p021 · **report version** (long)

**Current:**

> So, for RQ2: the stored files are intact, the hand-labelled pinch-in split is free of exact duplicates, and the stored development result can be reproduced. We cannot conclude that the manual relabelling improved recall over the older model, because the labels, recordings, preprocessing and thresholds all changed at once.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p021 -->

<!-- block 06-results/p022 -->
#### ¶ p022 · **papers version** (short)

**Current:**

> For RQ2, the stored result is reproducible and its split is free of exact duplicates, but we cannot credit any gain to relabelling, because labels, recordings, preprocessing and thresholds all changed together.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p022 -->

### Historical diagnostics, not current-model validation

<!-- block 06-results/p023 -->
#### ¶ p023 · **report version** (long)

**Current:**

> Earlier fusion experiments on a frozen benchmark raised the worst-split AUC from 0.789 to 0.837. That is a reason to study inertial fusion further, but it does not measure what PPG contributes to the current CNN. A matched comparison of IMU-only, PPG-only and fused inputs is still needed.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p023 -->

<!-- block 06-results/p024 -->
#### ¶ p024 · **papers version** (short)

**Current:**

> Earlier exploratory work points to the open issues behind RQ3. Fusing inertial data raised worst-split AUC from 0.789 to 0.837 on a frozen benchmark, and a strong movement burst can inflate the normalisation scale and hide a pinch that follows it. Both need matched tests on the current model.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p024 -->

<!-- block 06-results/p025 -->
#### ¶ p025 · **report version** (long)

**Current:**

> The motion-normalisation study found a likely failure mode: a strong movement burst inflates the rolling scale and shrinks a pinch that follows it. Median scaling helped in several synthetic splices, but those numbers only checked whether the peak score 0.1–1\,s after the start crossed the threshold. That is neither continuous causal recall nor a live robustness test, and long bursts were still a problem.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p025 -->

<!-- block 06-results/p026 -->
#### ¶ p026 · **report version** (long)

**Current:**

> A November curriculum report recorded 15 of 19 pinch-in and 10 of 19 pinch-out catches on a small reserved pair of recordings, with no false activations. The same pair was used to choose the thresholds, so this is exploratory. These results answer RQ3: variation across days, label uncertainty, changes in normalisation and reuse of evaluation data limit our claims more than the choice of architecture does.

✏️ **Your rewrite** (write below this line; leave empty to keep the current text):

<!-- end 06-results/p026 -->
