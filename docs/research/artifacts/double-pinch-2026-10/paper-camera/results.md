# ViWatch and Tsunoda et al. on the camera-timed gestures

Camera-timed gestures: 2026-10-14: pinch 209, fist 73, hand_open 0; 2026-10-17: pinch 69, fist 9, hand_open 69.
Thresholds set so each paper's own segmentation lands on the most camera-timed gestures.

## ViWatch, within the two days (3:1:1; pinch, fist, hand open)

326 segments (pinch 203, fist 67, hand_open 56); 76% of camera-timed gestures got a segment.

| | Accuracy | Balanced accuracy | Always the largest class |
|---|---:|---:|---:|
| Backbone CNN | 77% | 74% | 62% |

## ViWatch, each day held out (pinch against fist)

| Held-out day | Test (pinch / fist) | Always the largest class | Backbone | DANN | Siamese DANN |
|---|---|---:|---|---|---|
| 2026-10-14 | 148 / 63 | 70% | 72% (balanced 64%) | 73% (balanced 64%) | 74% (balanced 65%) |
| 2026-10-17 | 43 / 6 | 88% | 90% (balanced 94%) | 90% (balanced 92%) | 90% (balanced 94%) |

## Tsunoda et al., each day held out (pinch against fist)

| Held-out day | Test (pinch / fist) | Always the largest class | SVM on all training gestures | 5 a gesture | 10 a gesture |
|---|---|---:|---|---|---|
| 2026-10-14 | 209 / 73 | 74% | 80% (balanced 75%) | 56% (balanced 59%) | – |
| 2026-10-17 | 68 / 9 | 88% | 91% (balanced 85%) | 74% (balanced 71%) | 78% (balanced 73%) |

1318.2 s.
