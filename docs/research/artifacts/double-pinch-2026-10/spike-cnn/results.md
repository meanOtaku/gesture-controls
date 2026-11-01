# A CNN on the spike and a little around it

278 camera-timed contacts; 246 have a candidate spike 0-0.4 s after them, and 187 of those pass the context rules (B0 steady before, B4 few spikes before). 241 pinch candidates and 316 other candidates for training (spikes of at least 0.183 m/s² after the 8 Hz high-pass). Scores are the average of 5 training runs.

## Whole recordings held out (5 folds): contacts found

| Window | Found at 1 false alarm/min | 0.5/min | 0.2/min | With the rules: 1/min | 0.5/min | 0.2/min |
|---|---:|---:|---:|---:|---:|---:|
| high-passed, ±0.1 s (spike only) | 45% | 25% | 14% | 44% | 31% | 11% |
| high-passed, ±0.2 s (spike and around) | 51% | 29% | 14% | 49% | 32% | 16% |
| high-passed, ±0.5 s | 47% | 35% | 19% | 47% | 31% | 25% |
| unfiltered, ±0.2 s | 72% | 53% | 17% | 57% | 50% | 23% |

## Each recording day held out: contacts found

| Window | Found at 1 false alarm/min | 0.5/min | 0.2/min | With the rules: 1/min | 0.5/min | 0.2/min |
|---|---:|---:|---:|---:|---:|---:|
| high-passed, ±0.1 s (spike only) | 13% | 8% | 4% | 13% | 8% | 4% |
| high-passed, ±0.2 s (spike and around) | 14% | 8% | 5% | 9% | 5% | 3% |
| high-passed, ±0.5 s | 13% | 9% | 5% | 8% | 7% | 4% |
| unfiltered, ±0.2 s | 24% | 18% | 13% | 15% | 10% | 6% |

## Candidates a minute in each activity, at 1 false alarm a minute on held-out recordings

Typing, mouse and arm movement: a model trained on all the other recordings (it never saw them). The rest: held-out scores from the recordings split. Without / with the rules.

| Window | everything_else recordings | fist | wrist twist | rest (pinch sessions) | thumbs up | typing | mouse | arm movement |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| high-passed, ±0.1 s (spike only) | 10.0 / 7.5 | 0.7 / 1.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 5.0 / 2.0 | 1.3 / 1.3 | 10.7 / 0.0 |
| high-passed, ±0.2 s (spike and around) | 8.5 / 7.0 | 0.7 / 1.2 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 1.0 / 0.0 | 0.0 / 0.0 | 5.3 / 0.0 |
| high-passed, ±0.5 s | 7.0 / 6.0 | 1.2 / 1.3 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 4.0 / 0.0 |
| unfiltered, ±0.2 s | 9.0 / 8.0 | 0.4 / 1.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.7 / 0.7 | 0.0 / 0.0 | 2.7 / 2.7 | 1.3 / 0.0 |

Minutes: everything_else recordings 2.0, fist 6.8, wrist twist 0.7, rest (pinch sessions) 0.1, thumbs up 1.4, typing 1.0, mouse 0.8, arm movement 0.8.

422.3 s.
