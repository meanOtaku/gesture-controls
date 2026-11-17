# Figure captions and evidence status

## 01-system-architecture — System architecture

**Evidence:** implemented architecture schematic

Implemented sensing/computation placement. Camera annotation is an offline path, not an operational input. This schematic is not a hardware-validation result.

**Alt text:** Headphones and watch feed targeting and recognition on a laptop, then a separate policy controls output.

**Transformations:** No transformation beyond labelled plotting of source values.

**Sources:** `docs/architecture/label-inference.md`, `docs/paper/manuscript/sections/03-system-design.tex`

## 02-interaction-policy — Interaction policy

**Evidence:** implemented policy schematic

Conceptual interaction state and cancellation paths. A recognizer event is not continuous control state, and silence is not release. Physical fault and task acceptance remain unmeasured here.

**Alt text:** Fresh pinch-in starts a grab; release or cancellation ends it, independently of classifier silence.

**Transformations:** No transformation beyond labelled plotting of source values.

**Sources:** `docs/paper/manuscript/sections/03-system-design.tex`

## 03-hardware-positioning — Hardware positioning

**Evidence:** literature-positioning schematic

Original comparison schematic, not product photographs. μDPad uses custom hardware; this project uses built-in commercial-watch sensors. The interaction concept overlaps. No accuracy superiority or first-commercial-watch claim is made.

**Alt text:** Custom spatial-PPG prototype contrasted with an unmodified commercial watch; no performance bars.

**Transformations:** No transformation beyond labelled plotting of source values.

**Sources:** `https://doi.org/10.1145/3776574.3831197`, `docs/paper/notes/PAPER_IMPROVEMENT_GUIDE.md`

## 04-annotation-telemetry — Observed telemetry and annotation

**Evidence:** observed raw-data excerpt

Unmodified recorded row subset around the first saved effective-label correction. Gesture bands are shaded and named. Green/red/IR are centred and divided by the unscaled MAD of the displayed excerpt for viewing only. No model scores, filtering or timing shifts are manufactured.

**Alt text:** PPG and gyroscope traces above original and corrected gesture-label bands.

**Transformations:** Display-only median/MAD scaling per PPG channel; gyroscope Euclidean norm; original timestamp differences.

**Sources:** `data/telemetry/ppg.csv`, `data/telemetry/imu.csv`, `data/telemetry/selection.json`

## 05-historical-score-timeline — Historical score timeline

**Evidence:** stored historical model replay

First 45 seconds of the stored pinch_in-ae0a22bf timeline. Vertical styles distinguish caught/missed reference starts; triangles mark actual stored emissions and background bands show stored gesture intervals. Scores/times were rounded by the original exporter. This is not a fresh inference run or a CNNv2 trace.

**Alt text:** Stored classifier score with threshold, actual emissions and caught or missed reference starts.

**Transformations:** Original exporter rounding retained; display cropped at 45 s; no interpolation over unavailable intervals.

**Sources:** `data/historical/report-figure-data.json`

## 06-sensor-delivery-timing — Sensor delivery timing

**Evidence:** stored historical timestamp analysis

Stored positive timestamp-gap histograms over the historical model cohort. Equal timestamps were excluded by the original exporter. Gaps at or above 100 ms were folded into the last 99–100 ms bin; maxima and >250 ms counts remain in the source JSON.

**Alt text:** PPG and IMU gap histograms distinguish real sampling/delivery from the inference grid.

**Transformations:** Counts normalized within stream; original tail clipping explicitly retained.

**Sources:** `data/historical/report-figure-data.json`

## 07-dataset-identity — Dataset identity audit

**Evidence:** historical and current dataset audits

Historical 37-export audit and the new read-only collection audit are separate snapshots. Exact hashes ignore label columns; they do not detect partial overlap. No duplicated source was found across the historical audited model split; duplicate presence alone does not prove leakage.

**Alt text:** Grouped bars compare exported folders with distinct exact PPG/IMU stream pairs at two snapshots.

**Transformations:** No transformation beyond labelled plotting of source values.

**Sources:** `data/historical/evidence-audit.json`, `data/current-inventory.json`

## 08-historical-day-transfer — Historical day transfer

**Evidence:** historical exploratory results

Historical camera-label leave-one-day-out exploration with the all-moments/no-still-hand-gate configuration. Counts sum to 161/372. Days are not independent confidence-interval replicates; these results are not directly comparable with a newer hand-labelled or multiclass cohort.

**Alt text:** Four bars show caught counts and recall varying across held-out days.

**Transformations:** No transformation beyond labelled plotting of source values.

**Sources:** `data/historical/day-transfer.md`

## 09-motion-recovery-documented — Motion-history recovery

**Evidence:** documented exploratory summary only

Counts transcribed programmatically from the original motion-hangover report for its 50-start pinch-in experiment. This is peak-window detection after a synthetic splice, not standard event recall, not raw replay regeneration, and not a live physical-motion study. No confidence intervals are asserted.

**Alt text:** Before/after scaling counts show recovery at five delays after a spliced six-second movement.

**Transformations:** Reported counts divided by 50; straight lines connect only the five documented conditions.

**Sources:** `data/documented/motion-hangover.md`

## 10-v2-operating-points — CNNv2 operating points

**Evidence:** stored benchmark with verified OOF threshold arithmetic

Each model is plotted at its stored chosen threshold. The two final V2 operating points were independently reselected from saved training-OOF budget tables; reference/app thresholds are stored values. This is a descriptive comparison, not an isolated component ablation. Repeated historical test exploration limits confirmatory interpretation; zero observed FA is not zero long-run risk.

**Alt text:** Context-specific event recall and false activations for four stored model operating points.

**Transformations:** Recall=100*caught/gestures; FAR=fa/negative_hours; no threshold optimized against test groups.

**Sources:** `data/v2/*.json`, `derived/metrics.json`

## 11-multiclass-confusion — Multiclass confusion matrix

**Evidence:** recomputed from original prediction vectors

Independently recomputed from all saved seed-17 held-out decision vectors. Rows are delayed annotated states; cells show row percentage and exact decision count. This is not onset-event accuracy or physical hold-duration accuracy.

**Alt text:** Four-class confusion matrix exposes weaker hold recall despite high overall accuracy.

**Transformations:** Argmax of stored probabilities; exact integer counts; row-normalized percentages.

**Sources:** `data/multiclass/predictions/*.npz`, `data/multiclass/snapshot.json`, `derived/confusion-seed-17.csv`

## 12-multiclass-seeds — Seed variation

**Evidence:** recomputed from original prediction vectors

All three models are shown, not an ensemble or a test-selected best seed. Accuracy, balanced accuracy and macro-F1 were recomputed from saved vectors. Seed variation on one split is not participant uncertainty.

**Alt text:** Three models have high overall accuracy but lower class-balanced scores.

**Transformations:** No transformation beyond labelled plotting of source values.

**Sources:** `data/multiclass/predictions/*.npz`, `derived/multiclass-metrics.csv`

## 13-multiclass-events — Multiclass continuous events

**Evidence:** stored events; frozen-source replay verified separately

Stored seed-17 event aggregates, with recall/FAR arithmetic checked in analyze.py and independently reproducible via replay.py using frozen trainer source and matching raw recordings. Hold recall means hold-entry detection, not duration accuracy. Event classes use different negative exposure denominators. No binary-superiority claim is made.

**Alt text:** Three panels report event recall, false activations and latency for pinch-in, pinch-out and hold entry.

**Transformations:** No transformation beyond labelled plotting of source values.

**Sources:** `data/multiclass/results.json`, `derived/event-replay-verification.json`

## 14-prospective-protocol — Proposed validation protocol

**Evidence:** proposed protocol — not performed

Proposed frozen development, physical perturbation, prospective generalisation and complete-interaction workflow. This figure contains no measured results. Required sample size/exposure must be decided from pilot variability and precision goals.

**Alt text:** Six connected steps separate development, freezing, new data and interaction validation.

**Transformations:** No transformation beyond labelled plotting of source values.

**Sources:** `docs/paper/notes/PAPER_IMPROVEMENT_GUIDE.md`

## 15-paired-model-summary — Paired detector summary

**Evidence:** documented summary only

Later paired-model Markdown summary: 95/120 pinch-in and 96/127 pinch-out catches. FAR was rounded in the original summary. Corresponding original full run artifacts were not recovered; similarly named results elsewhere have different denominators and were deliberately not substituted. Do not combine these with the older 47/57 cohort or call this a freshly verified model comparison.

**Alt text:** Three panels reproduce documented paired-detector recall, rounded FAR and median latency.

**Transformations:** No transformation beyond labelled plotting of source values.

**Sources:** `data/documented/paired-models.md`

## 16-cnnv2-architecture — CNNv2 architecture

**Evidence:** implemented architecture schematic

Conceptual newer input/branch structure, not a layer-exact network diagram or proof that every sensor samples at 100 Hz. Binary onset and delayed-state experiments must remain distinct.

**Alt text:** Three sensor-specific paths feed shared processing and an output head.

**Transformations:** No transformation beyond labelled plotting of source values.

**Sources:** `tools/label-trainer/src/label_trainer/cnn_v2.py`, `crates/pinch-inference/src/cnn_input.rs`
