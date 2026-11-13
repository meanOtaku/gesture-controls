# The paper's ideas on the trees, `pinch_out`

Pinches caught of those in the 11 recordings no variant trained on, at the cut-off that catches the most within each
budget of false activations an hour (chosen on these recordings: for comparing variants only). In brackets, of the
three sessions of 9 Nov alone. See `paper_experiments.py`.

| variant | seed | features | within 2 an hour | within 5 an hour | within 10 an hour | seconds |
|---|---:|---:|---|---|---|---:|
| trees | 17 | 2733 | 94/134 (39/72) at 0.8 | 110/134 (53/72) at 0.7 | 115/134 (56/72) at 0.65 | 57 |
| trees | 18 | 2733 | 98/134 (43/72) at 0.8 | 104/134 (48/72) at 0.75 | 114/134 (57/72) at 0.65 | 57 |
| trees+spectral | 17 | 2949 | 88/134 (39/72) at 0.85 | 104/134 (49/72) at 0.8 | 113/134 (56/72) at 0.7 | 61 |
| trees+spectral | 18 | 2949 | 103/134 (51/72) at 0.8 | 111/134 (55/72) at 0.75 | 111/134 (55/72) at 0.75 | 60 |
| trees@100 | 17 | 2733 | 115/134 (56/72) at 0.75 | 118/134 (58/72) at 0.7 | 118/134 (58/72) at 0.7 | 63 |
| trees@100 | 18 | 2733 | 114/134 (56/72) at 0.75 | 118/134 (58/72) at 0.7 | 118/134 (58/72) at 0.7 | 64 |
| trees+spectral@100 | 17 | 2949 | 112/134 (55/72) at 0.75 | 112/134 (55/72) at 0.75 | 118/134 (59/72) at 0.6 | 68 |
| trees+spectral@100 | 18 | 2949 | 106/134 (53/72) at 0.8 | 113/134 (56/72) at 0.75 | 118/134 (59/72) at 0.65 | 68 |

## Where the false activations fell

At each run's best cut-off within 5 an hour: the label held where the start it fired for would be.

| variant | seed | false activations | on |
|---|---:|---:|---|
| trees | 17 | 2 | everyday_noise 2 |
| trees | 18 | 2 | everyday_noise 2 |
| trees+spectral | 17 | 2 | everyday_noise 2 |
| trees+spectral | 18 | 2 | everyday_noise 2 |
| trees@100 | 17 | 2 | everyday_noise 2 |
| trees@100 | 18 | 2 | everyday_noise 2 |
| trees+spectral@100 | 17 | 1 | everyday_noise 1 |
| trees+spectral@100 | 18 | 2 | everyday_noise 2 |
