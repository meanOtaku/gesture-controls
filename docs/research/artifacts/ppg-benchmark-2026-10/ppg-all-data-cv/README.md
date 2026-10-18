# Disposable all-data PPG-only binary pinch-start grouped CV

Oct-17 data has been incorporated. These results must not be compared as an independent test. This is explicitly NOT an untouched generalization test. No missing historical methods have been recovered or claimed.

All work and outputs are under `/tmp/ppg-all-data-cv`. Repository, recording data, and Git state are read-only. `before-hashes.json` and `hashes.json` cover repository files including data and Git, excluding dependency/cache directories `node_modules`, `.venv`, `__pycache__`, `target`, and `.tools`. No Git commands are used. Python bytecode writing is disabled.

## Frozen methods and eligibility

`frozen/` contains byte-identical copies of the source runner, audited preprocessing/parser, 26-method ledger, exclusions, and original freeze hashes from `/tmp/ppg-oct17-binary-techniques`. The original ledger's date-held-out protocol describes the prior study, not this CV study. This study replaces only orchestration, split membership, and reporting. The adapter executes the unchanged runner with its original `__file__` to satisfy its path guard, redirects output, and verifies copied freeze hashes. Model definitions, feature calculations, augmentation, random seeds, hyperparameters and training epochs remain unchanged.

The same eligibility policy is retained: recordings in `data/recordings/2026-10-downloads` through Oct-17, invalid-clock duration >=1 hour excluded, inherited pre-Oct-17 unlabeled/hand-twit/pinch-open categories excluded, pre-Oct-17 unmarked-only recordings excluded except everything_else, and recordings without eligible sampled events excluded. Every candidate and exclusion reason is in `inventory.json`. Oct-17's five recordings are incorporated into the common split pool. Filename use is limited to inherited eligibility and deterministic event sampling; filenames are not runtime features. Labels (including annotations stored in IMU CSVs) define evaluation targets only. No IMU values, contact quality fields, event kinds or labels enter the feature/model interface. Methods with “quality” in their names use only PPG waveform statistics.

## Split and fitting protocol

The inventory contains 37 eligible recordings (including all five Oct-17 recordings), 9 excluded recordings, and 1,390 sampled events (424 positive). Each split has 22 training and 15 held-out recordings. All 20 splits and every internal ensemble subset pass class coverage; no fallback protocol was necessary.

20 fixed `GroupShuffleSplit(n_splits=20, test_size=.4, random_state=17)` splits over recording IDs. Test group count is ceil(0.4 * recording count), with remaining groups training. Splits are accepted only if every training and test fold contains both classes, and each internal leave-training-recording-out ensemble member retains both classes. All eligible recordings must occur in at least one test fold. `splits.json` contains complete memberships and class counts. Splits are fixed before model scores are computed; there is no score-based split selection.

Positive target is pinch_start only; all other sampled events are negative. Every learned scaler, selector, model, augmentation and domain procedure fits solely on that fold's training recordings. Each internal ensemble member fits on a subset of those training recordings. Deterministic, past-only per-recording normalization and feature extraction can be cached before splitting because they learn no population parameters and access no labels. Predictions are generated only for held-out recordings. Each full serialized fitted model is hashed before and after prediction to verify no prediction-time fitting or mutation.

Ranking is descending minimum fold AUC, then arithmetic mean fold AUC, then maximum fold AUC. Pooled OOF AUC concatenates held-out event appearances across the 20 splits. An event held out multiple times contributes multiple predictions; it is not averaged, and repeated splits are not independent replicates. The fold range is not a confidence interval. No threshold, feature or model tuning is performed using OOF scores.

## Continuous evaluation

Only held-out continuous timelines are evaluated, separately by fold and recording, with no cross-recording activation carryover. Anchors run every 40 ms from 2500 ms to duration minus 1500 ms (exclusive). Decisions occur at anchor +880 ms, the end of the causal feature window. Threshold is fixed at 0.5. Rising edges use a 1500 ms refractory period. Greedy one-to-one onset matching accepts decision times in onset +680 through +1280 ms, preferring nearest onset +880 ms. Unmatched activations are false activations; denominator is the full evaluated timeline duration, including one grid interval after the final anchor. This is not a false-positive rate over verified background. Recall, precision, activation counts, mean detection latency and false activations/minute are retained per fold/session and pooled. Pooled continuous metrics likewise count every held-out timeline appearance, with duration/count weighting. Unmarked data may contain unlabeled pinches. Legacy compressed timestamps remain unrepaired.

## Files and reproduction

- `study.py`: adapter and study driver; `prepare` builds inventory/features/splits, `run` fits and scores.
- `verify.py`: separate saved-prediction verifier, independently using rank-sum AUC and separately implemented continuous matching; re-parses raw annotations with the frozen parser.
- `scores.json`, `report.md`: complete numeric results and ranked summary.
- `*-events.csv.gz`: fold, event ID (index in `events.json`), OOF probability.
- `*-continuous.csv.gz`: fold, recording, exact int64 anchor/decision timestamps, OOF probability.
- `self-check.json`, `train-only-checks.json`, `independent-verification.json`: binary/causal/feature invariance, fitting provenance and verification.
- `hashes.json`, `artifact-hashes.json`, `environment.json`: provenance and environment.
- `final_check.py`: raw-event regeneration and formatted report verification.
- `protocol.json`, `blockers.json`: exact protocol, held-out appearance counts, limitations and blockers.
- `prepared.pkl`: local feature cache, only load this trusted local artifact.

Run with `/home/vaibhav/.local/share/uv/tools/headroom-ai/bin/python`, `PYTHONDONTWRITEBYTECODE=1`, and working directory `/tmp/ppg-all-data-cv`. Commands in order: `study.py prepare`, `study.py run`, `verify.py`, `final_check.py`. These overwrite this disposable study's artifacts. Frozen definitions remain unchanged.
