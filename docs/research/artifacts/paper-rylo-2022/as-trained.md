# The variants as the app's training judges them

Cut-off chosen on the training recordings only; the 11 held-out recordings replayed once at it (seed 17). See
`as_trained.py`.

| model | variant | cut-off | caught | false activations an hour | median delay | false activations on |
|---|---|---:|---|---:|---:|---|
| pinch_in | trees | 0.75 | 89/128 | 1.8 | 934 ms | unlabelled 1 |
| pinch_in | trees+spectral | 0.7 | 99/128 | 1.8 | 918 ms | unlabelled 1 |
| pinch_in | trees@100 | 0.7 | 99/128 | 3.5 | 933 ms | everyday_noise 1, unlabelled 1 |
| pinch_in | trees+spectral@100 | 0.6 | 111/128 | 3.5 | 918 ms | everyday_noise 1, unlabelled 1 |
| pinch_out | trees | 0.65 | 115/134 | 8.5 | 908 ms | everyday_noise 4, pinch_in 1 |
| pinch_out | trees+spectral | 0.6 | 114/134 | 18.7 | 911 ms | everyday_noise 6, pinch_in 4, unlabelled 1 |
| pinch_out | trees@100 | 0.65 | 118/134 | 5.1 | 908 ms | everyday_noise 3 |
| pinch_out | trees+spectral@100 | 0.65 | 117/134 | 6.8 | 908 ms | everyday_noise 4 |
| pinch_in | cnn | 0.99 | 95/120 | 3.6 | 451 ms | unlabelled 2 |
| pinch_in | cnn, seed 18 | 0.99 | 91/120 | 3.6 | 494 ms | unlabelled 2 |
| pinch_in | cnn@100 | 0.99 | 96/120 | 3.6 | 451 ms | unlabelled 2 |
| pinch_in | cnn@100, seed 18 | 0.99 | 92/120 | 3.6 | 434 ms | unlabelled 2 |
| pinch_out | cnn | 0.99 | 96/127 | 3.4 | 434 ms | everyday_noise 2 |
| pinch_out | cnn, seed 18 | 0.99 | 92/127 | 0.0 | 444 ms | - |
| pinch_out | cnn@100 | 0.9 | 102/127 | 3.4 | 449 ms | everyday_noise 2 |
| pinch_out | cnn@100, seed 18 | 0.95 | 100/127 | 3.4 | 468 ms | everyday_noise 2 |
