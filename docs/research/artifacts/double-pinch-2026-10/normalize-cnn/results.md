# The spike CNN after scaling each axis to 0-1

278 camera-timed contacts; 246 have a candidate spike 0-0.4 s after them, and 187 of those pass the context rules (B0 steady before, B4 few spikes before). 241 pinch candidates and 316 other candidates for training (spikes of at least 0.183 m/s² after the 8 Hz high-pass). Scores are the average of 5 training runs.

## Whole recordings held out (5 folds): contacts found

| Window | Found at 1 false alarm/min | 0.5/min | 0.2/min | With the rules: 1/min | 0.5/min | 0.2/min |
|---|---:|---:|---:|---:|---:|---:|
| raw, high-passed | 51% | 29% | 14% | 49% | 32% | 16% |
| raw | 72% | 53% | 17% | 57% | 50% | 23% |
| z-score, sigmoid, high-pass | 56% | 40% | 16% | 50% | 37% | 21% |
| z-score, sigmoid | 67% | 49% | 33% | 57% | 50% | 28% |
| z-score, high-pass | 56% | 41% | 15% | 52% | 38% | 24% |
| min-max, high-pass | 56% | 39% | 17% | 52% | 40% | 20% |

## Each recording day held out: contacts found

| Window | Found at 1 false alarm/min | 0.5/min | 0.2/min | With the rules: 1/min | 0.5/min | 0.2/min |
|---|---:|---:|---:|---:|---:|---:|
| raw, high-passed | 14% | 8% | 5% | 9% | 5% | 3% |
| raw | 24% | 18% | 13% | 15% | 10% | 6% |
| z-score, sigmoid, high-pass | 33% | 15% | 9% | 26% | 14% | 8% |
| z-score, sigmoid | 42% | 27% | 16% | 39% | 29% | 15% |
| z-score, high-pass | 27% | 20% | 6% | 20% | 15% | 4% |
| min-max, high-pass | 29% | 15% | 10% | 23% | 10% | 5% |

## Candidates a minute in each activity, at 1 false alarm a minute on held-out recordings

Typing, mouse and arm movement: a model trained on all the other recordings (it never saw them). The rest: held-out scores from the recordings split. Without / with the rules.

| Window | everything_else recordings | fist | wrist twist | rest (pinch sessions) | thumbs up | typing | mouse | arm movement |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| raw, high-passed | 8.5 / 7.0 | 0.7 / 1.2 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 1.0 / 0.0 | 0.0 / 0.0 | 5.3 / 0.0 |
| raw | 9.0 / 8.0 | 0.4 / 1.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.7 / 0.7 | 0.0 / 0.0 | 2.7 / 2.7 | 1.3 / 0.0 |
| z-score, sigmoid, high-pass | 8.0 / 7.0 | 1.2 / 1.5 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 2.0 / 0.0 | 4.0 / 0.0 | 5.3 / 0.0 |
| z-score, sigmoid | 5.0 / 5.5 | 1.6 / 1.8 | 1.4 / 1.4 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 1.3 / 1.3 | 6.7 / 0.0 |
| z-score, high-pass | 8.0 / 7.0 | 1.3 / 1.2 | 0.0 / 0.0 | 0.0 / 10.1 | 0.0 / 0.0 | 1.0 / 0.0 | 2.7 / 0.0 | 5.3 / 0.0 |
| min-max, high-pass | 8.0 / 8.5 | 1.2 / 0.9 | 0.0 / 0.0 | 10.1 / 0.0 | 0.0 / 0.0 | 0.0 / 1.0 | 2.7 / 0.0 | 5.3 / 0.0 |

Minutes: everything_else recordings 2.0, fist 6.8, wrist twist 0.7, rest (pinch sessions) 0.1, thumbs up 1.4, typing 1.0, mouse 0.8, arm movement 0.8.

595.6 s.
