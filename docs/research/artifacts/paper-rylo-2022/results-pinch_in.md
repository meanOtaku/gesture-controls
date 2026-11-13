# The paper's ideas on the trees, `pinch_in`

Pinches caught of those in the 11 recordings no variant trained on, at the cut-off that catches the most within each
budget of false activations an hour (chosen on these recordings: for comparing variants only). In brackets, of the
three sessions of 9 Nov alone. See `paper_experiments.py`.

| variant | seed | features | within 2 an hour | within 5 an hour | within 10 an hour | seconds |
|---|---:|---:|---|---|---|---:|
| trees | 17 | 2733 | 89/128 (29/66) at 0.75 | 91/128 (31/66) at 0.7 | 94/128 (34/66) at 0.65 | 63 |
| trees | 18 | 2733 | 85/128 (27/66) at 0.75 | 90/128 (31/66) at 0.7 | 94/128 (35/66) at 0.65 | 63 |
| trees+spectral | 17 | 2949 | 99/128 (39/66) at 0.7 | 99/128 (39/66) at 0.7 | 103/128 (43/66) at 0.65 | 66 |
| trees+spectral | 18 | 2949 | 100/128 (40/66) at 0.7 | 100/128 (40/66) at 0.7 | 101/128 (41/66) at 0.65 | 69 |
| trees@25 | 17 | 2733 | 51/128 (3/66) at 0.95 | 64/128 (8/66) at 0.9 | 80/128 (21/66) at 0.75 | 62 |
| trees@25 | 18 | 2733 | 65/128 (9/66) at 0.9 | 65/128 (9/66) at 0.9 | 80/128 (21/66) at 0.75 | 63 |
| trees@100 | 17 | 2733 | 94/128 (35/66) at 0.75 | 104/128 (43/66) at 0.65 | 108/128 (47/66) at 0.6 | 76 |
| trees@100 | 18 | 2733 | 99/128 (40/66) at 0.7 | 102/128 (41/66) at 0.65 | 107/128 (46/66) at 0.6 | 70 |
| trees+spectral@100 | 17 | 2949 | 111/128 (51/66) at 0.65 | 111/128 (51/66) at 0.65 | 112/128 (52/66) at 0.55 | 67 |
| trees+spectral@100 | 18 | 2949 | 110/128 (50/66) at 0.65 | 111/128 (51/66) at 0.6 | 111/128 (51/66) at 0.6 | 68 |
| trees-top50 | 17 | 50 | 73/128 (16/66) at 0.95 | 79/128 (22/66) at 0.9 | 85/128 (27/66) at 0.8 | 59 |
| trees-top50 | 18 | 50 | 76/128 (19/66) at 0.9 | 76/128 (19/66) at 0.9 | 85/128 (27/66) at 0.8 | 59 |
| trees-top200 | 17 | 200 | 85/128 (26/66) at 0.85 | 90/128 (31/66) at 0.8 | 96/128 (35/66) at 0.75 | 59 |
| trees-top200 | 18 | 200 | 90/128 (32/66) at 0.8 | 90/128 (32/66) at 0.8 | 95/128 (35/66) at 0.7 | 59 |
| trees-top500 | 17 | 500 | 89/128 (30/66) at 0.75 | 89/128 (30/66) at 0.75 | 95/128 (35/66) at 0.65 | 60 |
| trees-top500 | 18 | 500 | 85/128 (26/66) at 0.8 | 89/128 (31/66) at 0.75 | 92/128 (33/66) at 0.7 | 60 |

## Where the false activations fell

At each run's best cut-off within 5 an hour: the label held where the start it fired for would be.

| variant | seed | false activations | on |
|---|---:|---:|---|
| trees | 17 | 2 | everyday_noise 1, unlabelled 1 |
| trees | 18 | 2 | everyday_noise 1, unlabelled 1 |
| trees+spectral | 17 | 1 | unlabelled 1 |
| trees+spectral | 18 | 1 | unlabelled 1 |
| trees@25 | 17 | 2 | unlabelled 2 |
| trees@25 | 18 | 1 | unlabelled 1 |
| trees@100 | 17 | 2 | everyday_noise 1, unlabelled 1 |
| trees@100 | 18 | 2 | everyday_noise 1, unlabelled 1 |
| trees+spectral@100 | 17 | 1 | unlabelled 1 |
| trees+spectral@100 | 18 | 2 | everyday_noise 1, unlabelled 1 |
| trees-top50 | 17 | 2 | everyday_noise 1, unlabelled 1 |
| trees-top50 | 18 | 1 | unlabelled 1 |
| trees-top200 | 17 | 2 | everyday_noise 1, unlabelled 1 |
| trees-top200 | 18 | 1 | unlabelled 1 |
| trees-top500 | 17 | 1 | unlabelled 1 |
| trees-top500 | 18 | 2 | everyday_noise 1, unlabelled 1 |

## The 15 features the trees found most useful (trees-top50, seed 17)

- `ppg_z2000ms_d2_red_n16_q10`
- `imu_accel_z_spread_vs_3s_n1280ms`
- `ppg_z1000ms_d1_red_n16_q10`
- `ppg_z2000ms_d3_red_n16_q10`
- `ppg_z1000ms_d3_red_n16_q90`
- `imu_accel_mag_spread_vs_3s_n1280ms`
- `ppg_z1000ms_d3_red_n16_q10`
- `ppg_z2000ms_d1_red_n16_q10`
- `ppg_z1000ms_d2_red_n16_q90`
- `ppg_z2000ms_d2_green_n16_q10`
- `ppg_z2000ms_d3_green_n16_q10`
- `ppg_z1000ms_d2_red_n16_q10`
- `ppg_z1000ms_d2_green_n16_q10`
- `ppg_z1000ms_d3_red_n16_mean_absolute_change`
- `ppg_z1000ms_d3_green_n16_q10`
