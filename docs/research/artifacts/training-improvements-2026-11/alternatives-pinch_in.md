# Other kinds of model for `pinch_in`

Pinches caught of those in the 11 recordings no model trained on, at the cut-off that catches the most within each
budget of false activations an hour (chosen on these recordings: for comparing models only). In brackets, of the
three sessions of 9 Nov alone. See `alternatives.py`.

| model | seed | within 2 an hour | within 5 an hour | within 10 an hour | seconds |
|---|---:|---|---|---|---:|
| cnn | 17 | 91/120 (44/63) at 0.999 | 97/120 (49/63) at 0.96 | 97/120 (49/63) at 0.96 | 55 |
| cnn | 18 | 88/120 (44/63) at 0.995 | 95/120 (48/63) at 0.95 | 95/120 (48/63) at 0.95 | 50 |
| cnn | 19 | 92/120 (47/63) at 0.995 | 99/120 (50/63) at 0.85 | 99/120 (50/63) at 0.85 | 69 |
| big | 17 | 90/120 (45/63) at 0.999 | 96/120 (48/63) at 0.99 | 100/120 (49/63) at 0.8 | 115 |
| big | 18 | none | 96/120 (49/63) at 0.98 | 97/120 (49/63) at 0.8 | 106 |
| big | 19 | 90/120 (43/63) at 0.999 | 99/120 (49/63) at 0.9 | 99/120 (49/63) at 0.9 | 99 |
| gru | 17 | none | 92/120 (43/63) at 0.99 | 95/120 (43/63) at 0.9 | 126 |
| gru | 18 | none | 87/120 (42/63) at 0.999 | 96/120 (46/63) at 0.5 | 149 |
| gru | 19 | none | 89/120 (44/63) at 0.999 | 101/120 (50/63) at 0.6 | 134 |
| multitask | 17 | 80/120 (40/63) at 0.999 | 96/120 (47/63) at 0.98 | 96/120 (47/63) at 0.98 | 128 |
| multitask | 18 | 92/120 (46/63) at 0.99 | 96/120 (48/63) at 0.97 | 97/120 (48/63) at 0.9 | 115 |
| multitask | 19 | 97/120 (49/63) at 0.99 | 99/120 (49/63) at 0.95 | 99/120 (49/63) at 0.95 | 114 |
| rocket | 17 | 90/120 (45/63) at 0.99 | 90/120 (45/63) at 0.99 | 98/120 (49/63) at 0.95 | 15 |
| rocket | 18 | 94/120 (48/63) at 0.97 | 94/120 (48/63) at 0.97 | 98/120 (52/63) at 0.9 | 13 |
| rocket | 19 | 96/120 (48/63) at 0.97 | 96/120 (48/63) at 0.97 | 96/120 (48/63) at 0.97 | 12 |
| boosted | 17 | 65/120 (34/63) at 0.999 | 82/120 (41/63) at 0.96 | 82/120 (41/63) at 0.96 | 35 |
| boosted | 18 | 70/120 (38/63) at 0.995 | 70/120 (38/63) at 0.995 | 79/120 (40/63) at 0.9 | 32 |
| boosted | 19 | 76/120 (41/63) at 0.99 | 84/120 (42/63) at 0.9 | 84/120 (42/63) at 0.9 | 35 |
| cnn+rocket | 17 | 100/120 (52/63) at 0.96 | 100/120 (52/63) at 0.96 | 100/120 (52/63) at 0.96 | 64 |
| cnn+rocket | 18 | 99/120 (51/63) at 0.9 | 99/120 (51/63) at 0.9 | 99/120 (51/63) at 0.9 | 60 |
| cnn+rocket | 19 | 101/120 (51/63) at 0.8 | 101/120 (51/63) at 0.8 | 101/120 (51/63) at 0.8 | 63 |

What it shows (13 Nov 2026, three seeds each):

- Within 5 false activations an hour no single model beats the CNN: the CNN caught 97, 95 and 99, twice the channels the
  same (96, 96, 99), one network for both pinches the same (96, 96, 99), random kernels a little fewer (90, 94, 96), a
  recurrent layer fewer (92, 87, 89) and boosted trees far fewer (82, 70, 84).
- The CNN and the random kernels averaged caught 100, 99 and 101, and kept that within 2 false activations an hour, where
  the CNN alone caught 91, 88 and 92. The two make different mistakes, so together they are surer of a pinch at a strict
  cut-off. It is the one change here that is outside the spread between seeds.
- The app cannot run the random kernels yet: `crates/label-inference` would need to evaluate them (fixed convolutions, the
  share above a threshold and the maximum of each, a scaled logistic regression), with the kernels and weights in the bundle.
