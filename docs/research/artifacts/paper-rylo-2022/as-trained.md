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
