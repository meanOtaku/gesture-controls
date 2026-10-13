# Green PPG pinch-onset experiments, October 2026

**Status:** research only. No experiment in this note changes the app's live feature contract or establishes a production model.

## Scope and data

The experiments use only the 26 recordings committed under `data/recordings/2026-10-downloads/`; `python3 scripts/recordings_manifest.py check` must pass before reproducing them. The loader repairs legacy millisecond PPG timestamps and preserves source sensor time. Arrival order and transport flush time are never used as signal time.

The target is **"did a pinch just start?"**, not "is a pinch held?":

- positives are labelled pinch starts with 2.5 s of preceding and 1.5 s of following data;
- rest controls are at least 1.5 s from every gesture start/end;
- mid-hold windows are excluded;
- all reported models are logistic regressions, trained only on feature values from their training recordings.

All causal transformations have a 2 s preceding baseline and require at least 20 earlier samples. Derivatives, when explored, are calculated only after a causal 25 Hz resample.

## Evaluation protocol

The baseline studies use leave-one-recording-session-out evaluation and repeat rest-control sampling with seeds 0--9. Each fold holds out a complete recording, preventing nearby overlapping windows from leaking into training.

The final 60/40 check holds out **four complete recordings** and trains on the remaining six. It repeats 50 deterministic recording-group splits for each of the 10 rest draws: 500 train/test evaluations per method. This is stronger than random window splitting, but it is still model-selection evidence because all recordings were used while exploring methods. A future, untouched capture set is required for acceptance.

## Feature definition

For a normalized signal in a candidate window from -400 ms to +900 ms, the onset step is:

```text
mean(signal from +400 to +900 ms) - mean(signal from -400 to -100 ms)
```

The direct robust-green baseline normalizes every raw green sample using the median and `1.4826 * MAD` of the previous 2 seconds.

The strongest mean 60/40 method applies two causal stages to green:

```text
raw green
-> z-score using mean/std of previous 2 s
-> sigmoid
-> round to 0.00001
-> robust median/MAD normalization of the transformed previous 2 s
-> onset step
-> logistic regression
```

Rounding is retained because it was explicitly tested. The measured improvement comes from the second normalization, not from rounding alone.

## Results

### 60/40 recording-group check

| Method | Mean test AUC | Median | Range | Standard deviation |
|---|---:|---:|---:|---:|
| Two-stage green | 0.713 | 0.714 | 0.500--0.902 | 0.087 |
| Green onset step + red/IR quality features | 0.667 | 0.685 | 0.381--0.864 | 0.087 |
| Direct robust green onset step | 0.661 | 0.659 | 0.451--0.868 | 0.061 |
| Green/red/IR robust steps | 0.658 | 0.649 | 0.422--0.903 | 0.084 |

The two-stage green method has the highest mean separation. Direct robust green is simpler and has lower split-to-split variation. Red/IR quality features provide no decisive improvement and have not been validated against labelled movement/contact artifacts.

### Findings from the broader leave-one-session-out screen

- Raw PPG post-start level was near chance across sessions (about 0.49--0.55 pooled AUC).
- A raw after-minus-before step improved over raw level, but transferred poorly (about 0.58--0.61).
- Causal robust-normalized step features transfer substantially better (about 0.72--0.74 pooled depending on zero-order-hold versus interpolation details).
- A 93-value causal slope waveform and a small neural network did not beat the simple step feature.
- Raw-baseline morphology plus boosted trees was promising but unstable across sessions; normalized morphology was weaker.
- Subtracting red/IR from green was consistently harmful:
  - causal red/IR regression residual: about 0.61;
  - causal min-max `green - red - IR`: about 0.68, with a worst session of 0.125;
  - z-score/sigmoid `green - red - IR`: about 0.68, with a worst session of 0.228;
  - transformed `green - red`: about 0.27.

Do not use red/IR subtraction as a green denoiser. Keep all channels and raw samples for future artifact analysis.

## Pinch-duration result

The event-locked duration script tests whether causal normalized green PPG recovery corresponds to the labelled physical pinch release. It is deliberately generous: labels select the event to score but do not supply PPG onset/peak/recovery landmarks.

- 137 eligible labelled pinch events; 116 valid PPG rise/recovery estimates (84.7%).
- Labelled duration median: 1,954 ms; PPG event duration median: 1,120 ms.
- Median absolute duration error: 624 ms.
- Only 36.2% of PPG recoveries were within +/-200 ms of the labelled release.

PPG is suitable for researching pinch **onset**. It is not validated for maintaining or releasing a continuous physical pinch state.

## Reproduction

From `tools/label-trainer`, after manifest verification:

```bash
python3 ../../scripts/recordings_manifest.py check
uv run --with numpy --with scikit-learn python \
  ../../docs/research/ppg-step-study/scripts/evaluate_green_onset_60_40.py .
uv run --with numpy python \
  ../../docs/research/ppg-step-study/scripts/evaluate_green_duration.py .
```

Existing baseline studies remain useful context:

- `compare_raw.py`: raw levels, raw steps and normalised steps;
- `onset_eval.py`: trainer feature-family comparison;
- `study.py` and `smoothing_check.py`: PPG step and causal smoothing investigation.

## Next evidence required

Freeze one feature pipeline before the next collection. Add unseen recordings containing varied pinch durations, watch/arm movement without pinch, strap/contact changes, and pinch while moving. Evaluate event precision/recall, false activations per hour, onset latency, and release error on that untouched set.
