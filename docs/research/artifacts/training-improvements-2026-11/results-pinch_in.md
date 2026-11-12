# Training variants for `pinch_in`

Pinches caught of those in the 11 recordings no variant trained on, at the cut-off that catches the most within each
budget of false activations an hour (chosen on these recordings: for comparing variants only). In brackets, of the
three sessions of 9 Nov alone. See `experiment.py`.

| variant | seed | within 2 an hour | within 5 an hour | within 10 an hour |
|---|---:|---|---|---|
| aug | 17 | none | 93/120 (45/63) at 0.999 | 93/120 (45/63) at 0.999 |
| aug | 18 | 91/120 (46/63) at 0.995 | 91/120 (46/63) at 0.995 | 91/120 (46/63) at 0.995 |
| base | 17 | none | 97/120 (48/63) at 0.995 | 100/120 (49/63) at 0.95 |
| base | 18 | 80/120 (41/63) at 0.999 | 95/120 (45/63) at 0.98 | 97/120 (46/63) at 0.96 |
| loop | 17 | none | 88/120 (43/63) at 0.999 | 98/120 (48/63) at 0.95 |
| loop | 18 | none | 100/120 (49/63) at 0.97 | 100/120 (49/63) at 0.97 |
| loop+aug | 17 | none | 102/120 (50/63) at 0.7 | 102/120 (50/63) at 0.7 |
| loop+aug | 18 | 88/120 (45/63) at 0.999 | 99/120 (49/63) at 0.9 | 100/120 (50/63) at 0.75 |
| base@100 | 17 | none | 95/120 (47/63) at 0.995 | 97/120 (49/63) at 0.85 |
| base@100 | 18 | 93/120 (46/63) at 0.99 | 93/120 (46/63) at 0.99 | 93/120 (46/63) at 0.99 |
| loop@100 | 17 | none | 93/120 (46/63) at 0.95 | 95/120 (48/63) at 0.85 |
