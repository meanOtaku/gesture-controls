"""Average the test-set scores of finished runs (saved by `bench.save` in the cache's scores/) and score the average.
Each run's timeline is matched on decision times: only moments every member scored are kept.
Usage: python ensemble.py <name> <run> <run> [...]"""
import sys

import numpy as np

import bench

name, runs = sys.argv[1], sys.argv[2:]
members = [np.load(bench.SCORES / f"{r}.npz") for r in runs]
timelines = {}
for rid in bench.test_ids():
    ts = [m[f"{rid}|t"] for m in members]
    common = ts[0]
    for t in ts[1:]:
        common = np.intersect1d(common, t)
    s = np.mean([m[f"{rid}|s"][np.searchsorted(t, common)] for m, t in zip(members, ts)], axis=0)
    timelines[rid] = (common, s)
res = bench.score_timelines(timelines)
bench.save(name, res, None, {"members": runs}, notes="Ensemble: the mean score of " + ", ".join(f"`{r}`" for r in runs) + ".")
