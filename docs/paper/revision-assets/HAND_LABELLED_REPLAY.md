# Hand-labelled pinch-in model: recovered event log

**Date:** 8 November 2026. **Model:** `pinch_in-ae0a22bf` (`trained-models/pinch_in-hand-labeled/`), SHA-256
`ae0a22bf8f744d5fa2fce9208221f0947288c5ba5c5eb196180985a70d77ba0d`, verified before scoring.
**Script:** [`replay_hand_labelled.py`](replay_hand_labelled.py). **Full output:** [`hand-labelled-replay.json`](hand-labelled-replay.json).

This closes the gap the [evidence audit](../EVIDENCE_AUDIT.md) recorded: the bundle stored an event recall and a
false-activation rate but no event log, counts, exposure or latencies. The replay recovers them. **It is development
evidence on the model's listed evaluation recordings, not an untouched test.**

## Method

The replay scores every PPG sample of the eight listed evaluation recordings with the checked-in model, using the
trainer's own code: `cnn_input` with median scaling (the bundle's `ppg_imu_cnn_median` contract), the runtime detection
rule `events.detect` (peak trigger, activation 0.99, release 0.84, cooldown 1,500 ms, all from the manifest) and the
event accounting of `label_train.detections`, as the [evaluation standard](../../research/gesture-detector-evaluation-metrics.md) defines it.

The original training spec was not saved anywhere in the repository or the app's Model Lab data (none of its 17 training
runs produced this model). Label roles were therefore reconstructed from the documented defaults: target `pinch_in`;
negatives `pinch_hold`, `pinch_out`, `fist`, `hand_open`, `everyday_noise`, `still`, `supported`; no label timings
(the manifest's cohort is `all`). The two uncertain settings, excluding `left_out` and the still-hand rule, were replayed
in all four combinations.

## Reproduction check

**All four variants reproduce the stored metrics exactly:** 47 of 57 starts caught (recall 0.8245614, the manifest's
0.8245614035) and 0 false activations. The result does not depend on the reconstructed settings. Scores were computed
once per recording and do not depend on label roles.

## Results

| Measure | Value |
| --- | --- |
| Pinch-in starts (eligible) | 57, in 3 pinch recordings (3, 4 and 6 November) |
| Caught | 47 (82.5%) |
| Missed | 10: 4 late (fired during the gesture, after the match window), 6 with no detection |
| Repeats | 0 |
| False activations | 0 |
| Eligible no-gesture time | 1,735.4 s (0.482 h) |
| 95% upper bound on false-activation rate (zero events, Poisson) | 6.2 per hour |
| Latency, start to emitted detection (n = 47) | median 442 ms; IQR 384–510 ms; p95 649 ms; range 303–755 ms |

Latency is measured at the causal emission time (the first fall after the score crosses the threshold), not a backdated
peak, and from the reference annotation's start.

### Per recording

| Recording | Starts | Caught | Late | False | No-gesture s | Max score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| everyday_noise 2026-11-04T04-27 | 0 | 0 | 0 | 0 | 599.0 | 0.970 |
| pinch_hold 2026-11-03T01-08 | 18 | 17 | 2 | 0 | 94.6 | 1.000 |
| pinch_hold 2026-11-04T04-50 | 21 | 17 | 2 | 0 | 105.6 | 1.000 |
| pinch_hold 2026-11-06T08-10 | 18 | 13 | 0 | 0 | 94.5 | 1.000 |
| still 2026-11-04T04-00 | 0 | 0 | 0 | 0 | 179.0 | 0.018 |
| still 2026-11-06T07-13 | 0 | 0 | 0 | 0 | 64.6 | 0.000 |
| supported 2026-11-06T06-27 | 0 | 0 | 0 | 0 | 299.0 | 0.002 |
| supported 2026-11-06T06-33 | 0 | 0 | 0 | 0 | 299.1 | 0.002 |

Recall varies by day: 94% on 3 November, 81% on 4 November, 72% on 6 November.

### Input availability (the audit's exposure concern)

Every recording has decisions at a steady 40 ms with **no interior gap over 250 ms**. The only undecided time is each
recording's first 11 s, the model's context warm-up, which falls outside the observed span. So the 1,735.4 s of
no-gesture time is not inflated by downtime. The evaluator code path the audit flagged remains worth fixing, but it did
not affect this result.

### Threshold sensitivity (diagnostic, not a threshold choice)

The 0.99 threshold was chosen on training recordings. Lowering it on these same recordings shows how thin the margin is:

| Threshold | Caught | False activations | Where |
| ---: | ---: | ---: | --- |
| 0.80 | 51/57 | 3 (6.2/h) | everyday noise ×2, unlabelled time ×1 |
| 0.95 | 48/57 | 2 (4.1/h) | everyday noise, unlabelled time |
| 0.97–0.98 | 47/57 | 1 (2.1/h) | unlabelled time inside a pinch recording |
| **0.99** | **47/57** | **0** | — |
| 0.995 | 46/57 | 0 | — |

The everyday-noise session peaks at 0.970, only 0.02 below the operating threshold. Zero false activations here reflects
a narrow margin over 10 minutes of everyday activity, not a demonstrated robustness to everyday use.

## What this can and cannot support

**Can:** a traceable development result for one identified model: 47/57 pinch-in starts, 0 false activations over
0.48 h of eligible no-gesture time (≤ 6.2/h at 95%), median emitted latency 442 ms, with per-recording outcomes and a
verified hash.

**Cannot:**

- An independent test. These recordings were listed for evaluation, but whether they informed labelling, architecture or
  model selection is not recorded.
- Generalisation. One participant, three pinch recordings on three days, ten minutes of everyday activity.
- Pinch-out or the paired interaction. There is no hand-labelled pinch-out bundle; resolve its cohort separately.
- All-day reliability. The 6.2/h bound comes from 0.48 h of exposure, and the everyday-noise margin is 0.02.

## Suggested paper text

> Replaying the checked-in hand-labelled pinch-in model (SHA-256 `ae0a22bf…`) over its eight listed evaluation
> recordings with the trainer's detection and event-accounting code reproduced its stored metrics exactly. It caught 47
> of 57 annotated starts (82.5%; 72–94% by day), with four late detections, no repeats and no false activations over
> 0.48 h of eligible no-gesture time (95% upper bound 6.2 per hour). Median latency from annotated start to causal
> detection was 442 ms (IQR 384–510 ms). The everyday-activity session's maximum score was 0.970 against a 0.99
> threshold chosen on training recordings, so the zero false-activation result rests on a narrow margin. These are
> development results for one participant and one target, not an independent test.
