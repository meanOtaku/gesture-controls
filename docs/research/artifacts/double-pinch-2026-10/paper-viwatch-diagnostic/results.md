# ViWatch on these recordings: which step costs the accuracy?

Leave one day out, pinch against fist; balanced accuracy (50% is chance), with accuracy in brackets. Mean of 3 runs.

| Variant | 2026-10-04 | 2026-10-11 | 2026-10-14 | 2026-10-17 | Mean balanced |
|---|---|---|---|---|---:|
| as published | 43% (43%) | 67% (65%) | 62% (77%) | 59% (80%) | 58% |
| no 20 Hz high-pass | 47% (47%) | 58% (59%) | 60% (75%) | 58% (74%) | 56% |
| no per-segment z-score | 57% (57%) | 59% (58%) | 54% (73%) | 60% (83%) | 57% |
| neither | 53% (53%) | 47% (42%) | 62% (71%) | 62% (88%) | 56% |
| class weights | 37% (37%) | 67% (67%) | 62% (74%) | 52% (76%) | 55% |

3575.2 s.
