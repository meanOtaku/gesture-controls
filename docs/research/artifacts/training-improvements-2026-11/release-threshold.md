# A lower `pinch_out` cut-off during a grab

The live `pinch_out-motion` model inside each hold of the 11 recordings it never trained on (see
`release_threshold.py`). A false release is a firing before the labelled release: the grab would drop early. In
brackets, the three sessions of 9 Nov alone.

| cut-off | releases caught | false releases | false releases an hour of holding |
|---:|---|---|---:|
| 0.3 | 98/124 (47/66) | 19 (12) | 443 |
| 0.4 | 100/124 (48/66) | 16 (10) | 373 |
| 0.5 | 101/124 (49/66) | 14 (8) | 327 |
| 0.6 | 101/124 (49/66) | 14 (8) | 327 |
| 0.7 | 102/124 (50/66) | 13 (7) | 303 |
| 0.8 | 98/124 (48/66) | 12 (6) | 280 |
| 0.9 | 95/124 (47/66) | 11 (5) | 257 |
| 0.95 | 93/124 (45/66) | 11 (5) | 257 |
| 0.97 | 91/124 (44/66) | 10 (4) | 233 |
| 0.99 | 87/124 (43/66) | 9 (3) | 210 |
