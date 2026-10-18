# All-data grouped cross-validation

26 frozen fresh methods; 37 eligible recordings, 1390 sampled events; 20 fixed recording-disjoint 60/40 splits (seed 17).

Oct-17 data has been incorporated. These results must not be compared as an independent test. This is not an untouched generalization test.

Pooled OOF metrics count each held-out appearance separately; recordings recur across splits. The fold range is descriptive, not a confidence interval.

| Method | Minimum AUC | Mean AUC | Maximum AUC | Pooled OOF AUC | OOF recall | False activations/min |
|---|---:|---:|---:|---:|---:|---:|
| hgb_morphology | 0.706832 | 0.779677 | 0.843306 | 0.767994 | 0.261251 | 19.091637 |
| extra_trees | 0.697313 | 0.777750 | 0.848449 | 0.764598 | 0.273816 | 14.719917 |
| dense_mlp | 0.673464 | 0.737353 | 0.782535 | 0.729899 | 0.267680 | 19.449533 |
| coral_training_mlp | 0.664554 | 0.735179 | 0.791810 | 0.725460 | 0.262712 | 13.984884 |
| group_dro_mlp | 0.660133 | 0.727338 | 0.784121 | 0.716874 | 0.235243 | 19.060850 |
| morphology_lr | 0.649873 | 0.718849 | 0.777543 | 0.706885 | 0.231736 | 16.636393 |
| anova32_lr | 0.646921 | 0.697256 | 0.751319 | 0.683348 | 0.264173 | 15.262534 |
| multiscale_lr | 0.644653 | 0.706817 | 0.762653 | 0.692608 | 0.241672 | 14.739159 |
| retained_lr_09 | 0.639932 | 0.706894 | 0.764659 | 0.698370 | 0.295441 | 18.537475 |
| retained_lr_03 | 0.639872 | 0.714322 | 0.800233 | 0.682632 | 0.067797 | 6.965503 |
| retained_lr_10 | 0.629721 | 0.704183 | 0.761145 | 0.695181 | 0.293688 | 18.683712 |
| retained_lr_02 | 0.626902 | 0.693895 | 0.768239 | 0.669279 | 0.104617 | 7.127134 |
| retained_lr_00 | 0.625652 | 0.687975 | 0.811273 | 0.646649 | 0.037405 | 3.494297 |
| leave_session_out_ensemble | 0.625039 | 0.701476 | 0.754806 | 0.694788 | 0.284629 | 24.483167 |
| augmented_waveform_lr | 0.617853 | 0.677250 | 0.729132 | 0.665701 | 0.306254 | 19.507258 |
| robust_scaler_lr | 0.617827 | 0.693189 | 0.744004 | 0.687159 | 0.286090 | 26.345766 |
| equal_session_lr | 0.613641 | 0.696735 | 0.753053 | 0.690198 | 0.275278 | 25.668457 |
| retained_lr_04 | 0.612297 | 0.677204 | 0.741420 | 0.664891 | 0.285213 | 17.629266 |
| retained_lr_06 | 0.608252 | 0.679741 | 0.750363 | 0.667604 | 0.281414 | 17.636963 |
| retained_lr_05 | 0.608252 | 0.679726 | 0.750270 | 0.667595 | 0.280830 | 17.663901 |
| retained_lr_01 | 0.600731 | 0.681016 | 0.774433 | 0.638082 | 0.039451 | 3.906070 |
| haar_lr | 0.600354 | 0.652141 | 0.687562 | 0.643589 | 0.298656 | 23.975186 |
| causal_cnn | 0.600026 | 0.715397 | 0.817588 | 0.697611 | 0.161894 | 11.972200 |
| augmented_cnn | 0.590532 | 0.729728 | 0.819056 | 0.718498 | 0.190240 | 14.273510 |
| retained_lr_08 | 0.560030 | 0.667936 | 0.751589 | 0.654731 | 0.310053 | 18.756831 |
| retained_lr_07 | 0.559950 | 0.667970 | 0.751669 | 0.654738 | 0.309176 | 18.760679 |

All 520 per-fold AUCs and every continuous per-fold/session result are retained in scores.json. All values independently verified from saved OOF predictions.
