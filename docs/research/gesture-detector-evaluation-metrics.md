# Gesture detector evaluation metrics

This project evaluates a pinch detector as a **continuous event detector**, not as a per-window classifier. ROC-AUC and window accuracy remain diagnostic values, but they are not release metrics.

## Decision flow

```text
Complete recording
  -> causal model scores
  -> frozen threshold, peak rule, hysteresis, and cooldown
  -> emitted activation events
  -> match one event to each labelled pinch_in event
  -> report true activations, misses, and false activations
```

Use the same runtime policy, event-match window, label mapping, and cohort ledger for every model comparison.

## Headline metrics

| Metric | Definition | Unit | Desired direction |
|---|---|---:|---|
| True Activation Rate (TAR) | labelled pinch events with exactly one matched valid activation / labelled pinch events | percent | higher |
| Miss Rate | labelled pinch events with no valid activation / labelled pinch events | percent | lower |
| False Activation Rate (FAR) | unmatched activation events / eligible non-pinch time | false activations per hour | lower |

TAR is event recall. Miss Rate is the false-negative rate, so it is always `100% - TAR`; show it alongside TAR for readability, not as independent evidence.

Do **not** define “no activation rate” as the fraction of quiet sample windows. That value is dominated by how often the watch samples and by recording length. Quiet non-pinch time is represented by FAR instead.

## Event accounting rules

- The positive unit is one labelled `pinch_in` event.
- A valid activation is the first emitted runtime event within the fixed causal match window for that pinch. Additional emitted events in that window are recorded as repeats, not additional true activations.
- A labelled pinch without a valid activation is a miss.
- An emitted event outside every match window is a false activation.
- `left_out` intervals and any interval without trustworthy timing are excluded from both event matching and eligible non-pinch time.
- Report repeat activations per 100 labelled pinches and median detection latency as companion metrics. They identify models that fire multiple times or only after the gesture is no longer useful.

## Comparison protocol

1. Freeze the target label, event-match window, causal feature pipeline, runtime policy, and cohort ledger before running models.
2. Choose a threshold using training/calibration recordings only. Never tune it on the final held-out cohort.
3. Replay each candidate over complete held-out recordings, not only windows near known gestures.
4. Report TAR, Miss Rate, FAR, repeat rate, and median latency separately for the **old-session** and **new-session** held-out cohorts. Do not blend them into a single score.
5. Use ROC-AUC and PR-AUC only to diagnose score ranking. Raw window accuracy is not a model-selection metric because pinch windows are rare; an always-no-pinch model can achieve high accuracy while detecting no gestures.
6. Mark camera-timed `pinch_in` results and motion-derived timing estimates separately. They are not interchangeable ground truth.

## Release gate

Select a model by its TAR at a declared FAR budget, for example:

> Maximize held-out TAR subject to FAR no greater than 2 false activations per minute.

A release report must state the FAR budget, cohort, threshold source, number of labelled events, eligible non-pinch duration, and whether labels are camera-timed or estimated. A high AUC alone cannot satisfy this gate.

## Legacy model comparison

Old and new models are comparable only when their stored outputs can be replayed through the same current event-matching policy on the same cohort ledger. If a legacy model has only aggregate AUC or window metrics, preserve those as historical diagnostics but do not rank it against a new model by the headline event metrics until it is replayed.
