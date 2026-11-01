# ViWatch (UIST 2023), as published, on these recordings

## Within the data (3:1:1 split, five gestures)

674 segments from 764 labelled gestures (pinch 416, fist 147, hand_open 77, thumbs_up 20, hand_twit_clockwise_and_anti_clockwise 14).

| | Accuracy | Balanced accuracy | Always the largest class |
|---|---:|---:|---:|
| Backbone CNN | 66% | 31% | 62% |

## Leave one day out (pinch against fist)

Each day's segments: a random half, labels removed, is the unlabelled set the adaptation uses; the other half is tested.

| Held-out day | Test segments (pinch / fist) | Always the largest class | Backbone | DANN | Siamese DANN |
|---|---|---:|---|---|---|
| 2026-10-04 | 19 (8 / 11) | 58% | 44% (balanced 46%) | 42% (balanced 43%) | 44% (balanced 45%) |
| 2026-10-11 | 64 (27 / 37) | 58% | 68% (balanced 70%) | 67% (balanced 70%) | 68% (balanced 70%) |
| 2026-10-14 | 259 (198 / 61) | 76% | 77% (balanced 58%) | 75% (balanced 60%) | 75% (balanced 58%) |
| 2026-10-17 | 81 (72 / 9) | 89% | 75% (balanced 59%) | 76% (balanced 56%) | 72% (balanced 55%) |
| Mean | | 70% | 66% (balanced 58%) | 65% (balanced 57%) | 65% (balanced 57%) |

2882.8 s.
