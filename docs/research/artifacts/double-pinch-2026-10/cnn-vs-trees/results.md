# Trees against the CNN, same recordings, same scoring

Pinch ins caught (of those counted) at the best threshold within each false-alarm budget, and the median time
from the pinch's start to the detection. See `cnn_vs_trees_check.py` for the method.

| Split | Hand | Model | ≤1 false alarm/min | ≤0.5/min | ≤0.2/min | Latency at ≤1/min |
|---|---|---|---:|---:|---:|---:|
| app split | still hand | trees | 27/42 (64%) | 11/42 (26%) | 11/42 (26%) | 873 ms |
| app split | still hand | cnn | 29/42 (69%) | 28/42 (67%) | 27/42 (64%) | 497 ms |
| train 10-14, test 10-17 | still hand | trees | 11/21 (52%) | 2/21 (10%) | 1/21 (5%) | 869 ms |
| train 10-14, test 10-17 | still hand | cnn | 11/21 (52%) | — | — | 494 ms |
| train 10-17, test 10-14 | still hand | trees | 70/150 (47%) | 63/150 (42%) | 29/150 (19%) | 923 ms |
| train 10-17, test 10-14 | still hand | cnn | 95/150 (63%) | 79/150 (53%) | 25/150 (17%) | 498 ms |
| app split | any | trees | 13/73 (18%) | 13/73 (18%) | 11/73 (15%) | 903 ms |
| app split | any | cnn | — | — | — | — |
| train 10-14, test 10-17 | any | trees | 18/61 (30%) | 4/61 (7%) | 3/61 (5%) | 885 ms |
| train 10-14, test 10-17 | any | cnn | — | — | — | — |
| train 10-17, test 10-14 | any | trees | 88/197 (45%) | 82/197 (42%) | 51/197 (26%) | 904 ms |
| train 10-17, test 10-14 | any | cnn | 64/197 (32%) | 56/197 (28%) | — | 507 ms |
