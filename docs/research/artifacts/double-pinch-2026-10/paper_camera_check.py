"""ViWatch and Tsunoda et al., as published, on the camera-timed gestures.

`paper_viwatch_check.py` and `paper_tsunoda_check.py` replicate the two papers. There, the unpublished detection
thresholds were set so 90% of labelled gestures reach them, and a gesture's segment was the first one from 1 s before
its label. Against the camera, those segments started a median 0.65 s before the fingers met, so most of ViWatch's
0.43 s windows ended before the gesture. Both papers say only that their thresholds were set empirically.

Here the thresholds are set empirically against the camera instead. The camera times every gesture in the 2026-10-14
and 2026-10-17 sessions: a pinch or a fist at the first thumb-to-index contact inside its label (from 1 s before), a
hand opening at the first release. Each paper's own segmentation is run at a range of thresholds on the training day,
and the threshold that puts a segment on the most camera-timed gestures is kept: a ViWatch segment starting within
0.15 s of the camera time, or a Tsunoda peak from 0.1 s before to 0.3 s after it. A gesture's segment is the matching
one nearest the camera time. Everything else is as in the two replication scripts (the same models, training,
adaptation, pre-training and scoring, and the same notes on what the papers leave out).

* ViWatch: within the two days (a 3:1:1 split; pinch, fist, hand open), and each day held out (pinch against fist),
  with its DANN and Siamese DANN.
* Tsunoda: each day held out (pinch against fist), the SVM on all training gestures and on 5 or 10 a gesture;
  pre-training on 5,106 unlabelled segments from the recordings of every other day.

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/paper_camera_check.py

Run from the repository root (about an hour). Writes paper-camera/results.json and results.md, and the ViWatch part to
paper-camera/viwatch.json first; with `--reuse-viwatch`, that file is read instead of training ViWatch again.
"""
import importlib.util, json, sys, time
from pathlib import Path
import numpy as np
import torch

HERE = Path(__file__).resolve().parent


def _load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


V = _load("paper_viwatch_check")
T = _load("paper_tsunoda_check")
M = V.M
C = M.C
S = M.S
DAYS = ("2026-10-14", "2026-10-17")
CLASSES = ("pinch", "fist", "hand_open")
PAIR = ("pinch", "fist")
VIWATCH_TOL_S = 0.15
TSUNODA_WINDOW_S = (-0.1, 0.3)
GRID = np.r_[np.linspace(0.50, 0.95, 10), np.linspace(0.96, 0.999, 10)]


def camera_onsets(r, bundles):
    """(watch-clock ns, class) for each labelled gesture the camera times, or [] without hand tracking."""
    path = next(p for f in M.FOLDERS for p in (M.ROOT / f).iterdir() if p.name == r["name"])
    start = M.started_at(path)
    bundle = next((b for t, b in bundles.items() if start and abs((t - start).total_seconds()) < 5), None)
    if bundle is None:
        return []
    offset = C.align(bundle / "clock_sync.csv")
    if offset is None:
        return []
    times, dist = C.camera_frames(bundle / "hand_landmarks.csv")
    contacts, releases = C.crossings(times, dist)
    contacts = (contacts - offset[0]) * 1e6; releases = (releases - offset[0]) * 1e6
    out = []
    for a, b, label in r["holds"]:
        if label in CLASSES:
            ev = releases if label == "hand_open" else contacts
            k = ev[(ev >= a - 1 * S) & (ev <= b)]
            if len(k):
                out.append((float(k[0]), CLASSES.index(label)))
    return out


def match(times_ns, onsets, lo_s, hi_s):
    """For each onset, the index of the nearest time within [lo, hi] s of it, or None."""
    out = []
    for t, c in onsets:
        d = (times_ns - t) / S
        ok = np.flatnonzero((d >= lo_s) & (d <= hi_s))
        out.append((ok[np.argmin(np.abs(d[ok]))], c) if len(ok) else (None, c))
    return out


def tune(recs, candidates, detect, times, lo_s, hi_s):
    """The candidate threshold that puts a segment on the most camera-timed gestures (ties: the higher)."""
    best = None
    for thr in candidates:
        hit = sum(i is not None for r in recs for i, _ in match(times(r, detect(r, thr)), r["onsets"], lo_s, hi_s))
        if best is None or hit >= best[1]:
            best = (thr, hit)
    return best[0], best[1] / max(1, sum(len(r["onsets"]) for r in recs))


def viwatch_items(recs, high, classes):
    items, offsets = [], []
    for r in recs:
        st = V.segments(r, high)
        for i, c in match(r["g100"][st] if len(st) else np.array([]), r["onsets"], -VIWATCH_TOL_S, VIWATCH_TOL_S):
            if i is not None and CLASSES[c] in classes:
                items.append((r, int(st[i]), classes.index(CLASSES[c])))
    return items


def tsunoda_items(recs, tau):
    items = []
    for r in recs:
        pk = T.detections(r, tau)
        for i, c in match(r["grid"][pk] if len(pk) else np.array([]), r["onsets"], *TSUNODA_WINDOW_S):
            if i is not None and CLASSES[c] in PAIR:
                items.append((r, int(pk[i]), PAIR.index(CLASSES[c])))
    return items


def summary(v):
    return {"accuracy": float(np.mean([a for a, _ in v])), "balanced": float(np.mean([b for _, b in v]))}


def main():
    t0 = time.time()
    torch.set_num_threads(8)
    out_dir = HERE / "paper-camera"; out_dir.mkdir(exist_ok=True)
    recs = M.load_all()
    bundles = M.camera_bundles()
    for r in recs:
        r["onsets"] = camera_onsets(r, bundles) if r["day"] in DAYS else []
        V.upsample(r); T.prepare(r)
    cam = [r for r in recs if r["onsets"]]
    counts = {d: {k: sum(1 for r in cam if r["day"] == d for _, c in r["onsets"] if c == i) for i, k in enumerate(CLASSES)} for d in DAYS}
    print(f"camera-timed gestures: {counts}", flush=True)
    results = {"camera_timed": counts, "viwatch": {}, "tsunoda": {}}
    saved = out_dir / "viwatch.json"
    reuse = "--reuse-viwatch" in sys.argv and saved.exists()
    if reuse:
        results["viwatch"] = json.loads(saved.read_text())["viwatch"]

    if not reuse:
        viwatch_part(cam, results)
        saved.write_text(json.dumps({"camera_timed": counts, "viwatch": results["viwatch"]}, indent=1))
    tsunoda_part(recs, cam, results)
    results["seconds"] = round(time.time() - t0, 1)
    report(results, counts, out_dir)


def viwatch_part(cam, results):
    def v_detect(r, thr):
        return V.segments(r, thr)

    def v_times(r, st):
        return r["g100"][st] if len(st) else np.array([])

    def v_candidates(pool):
        return np.quantile(np.concatenate([r["energy"] for r in pool]), GRID)

    # Within the two days.
    high, share = tune(cam, v_candidates(cam), v_detect, v_times, -VIWATCH_TOL_S, VIWATCH_TOL_S)
    items = viwatch_items(cam, high, CLASSES)
    y = np.array([c for *_, c in items])
    raw = np.concatenate([V.raw_segments(r, [(s, c)]) for r, s, c in items])
    got = []
    for run in range(V.RUNS):
        rng = np.random.default_rng(M.SEED + run)
        idx = rng.permutation(len(items)); n = len(idx)
        tr, te = idx[:int(0.8 * n)], idx[int(0.8 * n):]
        X = V.finish(raw, V.template_of(raw[tr]))
        model, _ = V.train_backbone(X[tr], y[tr], len(CLASSES), M.SEED + run)
        got.append(V.scores(V.accuracy(model, X[te], y[te]), y[te], len(CLASSES)))
    per_class = {CLASSES[c]: int((y == c).sum()) for c in range(len(CLASSES))}
    results["viwatch"]["within"] = {"matched_share": share, "segments": len(items), "per_class": per_class,
                                    "majority": max(per_class.values()) / len(items), **summary(got)}
    print(f"viwatch within: {results['viwatch']['within']}", flush=True)

    # ViWatch, each day held out.
    for day in DAYS:
        train_recs = [r for r in cam if r["day"] != day]; test_recs = [r for r in cam if r["day"] == day]
        high, share = tune(train_recs, v_candidates(train_recs), v_detect, v_times, -VIWATCH_TOL_S, VIWATCH_TOL_S)
        tr_items, te_items = viwatch_items(train_recs, high, PAIR), viwatch_items(test_recs, high, PAIR)
        raw_tr = np.concatenate([V.raw_segments(r, [(s, c)]) for r, s, c in tr_items])
        raw_te = np.concatenate([V.raw_segments(r, [(s, c)]) for r, s, c in te_items])
        tmpl = V.template_of(raw_tr)
        Xtr, Xte = V.finish(raw_tr, tmpl), V.finish(raw_te, tmpl)
        ytr = np.array([c for *_, c in tr_items]); yte = np.array([c for *_, c in te_items])
        dom = np.zeros(len(ytr), dtype=int)
        got = {"backbone": [], "DANN": [], "Siamese DANN": []}
        for run in range(V.RUNS):
            seed = M.SEED + run
            half = np.random.default_rng(seed).permutation(len(yte)); T_train, T_test = half[:len(half) // 2], half[len(half) // 2:]
            model, va = V.train_backbone(Xtr, ytr, 2, seed)
            got["backbone"].append(V.scores(V.accuracy(model, Xte[T_test], yte[T_test]), yte[T_test], 2))
            for name, siamese in (("DANN", False), ("Siamese DANN", True)):
                adapted = V.adapt(model, Xtr, ytr, dom, va, Xte[T_train], 2, seed, siamese)
                got[name].append(V.scores(V.accuracy(adapted, Xte[T_test], yte[T_test]), yte[T_test], 2))
        results["viwatch"][day] = {"matched_share_train": share, "train": len(ytr), "test_pinch": int((yte == 0).sum()),
                                   "test_fist": int((yte == 1).sum()), "majority": float(max((yte == 0).mean(), (yte == 1).mean())),
                                   **{k: summary(v) for k, v in got.items()}}
        print(f"viwatch {day}: {results['viwatch'][day]}", flush=True)



def tsunoda_part(recs, cam, results):
    def t_detect(r, tau):
        return T.detections(r, tau)

    def t_times(r, pk):
        return r["grid"][pk] if len(pk) else np.array([])

    for day in DAYS:
        train_cam = [r for r in cam if r["day"] != day]; test_cam = [r for r in cam if r["day"] == day]
        tau, share = tune(train_cam, np.quantile(np.concatenate([r["rx"] for r in train_cam]), GRID), t_detect, t_times, *TSUNODA_WINDOW_S)
        unl = np.concatenate([T.windows(r, T.detections(r, tau)) for r in recs if r["day"] != day])
        if len(unl) > T.PRETRAIN_SEGMENTS:
            unl = unl[np.random.default_rng(M.SEED).choice(len(unl), T.PRETRAIN_SEGMENTS, replace=False)]
        tr, te = tsunoda_items(train_cam, tau), tsunoda_items(test_cam, tau)
        Xtr = np.concatenate([T.windows(r, [i]) for r, i, _ in tr]); ytr = np.array([c for *_, c in tr])
        Xte = np.concatenate([T.windows(r, [i]) for r, i, _ in te]); yte = np.array([c for *_, c in te])
        got = {"all": [], **{f"{n} a gesture": [] for n in T.SHOTS}}
        for run in range(T.RUNS):
            seed = M.SEED + run
            model, scale = T.pretrain(unl, seed)
            Ftr, Fte = model.features((Xtr / scale).astype(np.float32)), model.features((Xte / scale).astype(np.float32))
            svm = T.make_pipeline(T.StandardScaler(), T.LinearSVC(C=1.0, max_iter=20000)).fit(Ftr, ytr)
            got["all"].append(T.scores(svm.predict(Fte), yte))
            rng = np.random.default_rng(seed)
            for n in T.SHOTS:
                if n > min((ytr == c).sum() for c in range(2)):
                    continue                          # fewer training gestures of a class than the draw needs
                pick = np.concatenate([rng.choice(np.flatnonzero(ytr == c), n, replace=False) for c in range(2)])
                svm = T.make_pipeline(T.StandardScaler(), T.LinearSVC(C=1.0, max_iter=20000)).fit(Ftr[pick], ytr[pick])
                got[f"{n} a gesture"].append(T.scores(svm.predict(Fte), yte))
        results["tsunoda"][day] = {"matched_share_train": share, "train": len(ytr), "test_pinch": int((yte == 0).sum()),
                                   "test_fist": int((yte == 1).sum()), "majority": float(max((yte == 0).mean(), (yte == 1).mean())),
                                   **{k: summary(v) if v else None for k, v in got.items()}}
        print(f"tsunoda {day}: {results['tsunoda'][day]}", flush=True)


def report(results, counts, out_dir):
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))
    w = results["viwatch"]["within"]
    cell = lambda v: "–" if v is None else f"{v['accuracy']:.0%} (balanced {v['balanced']:.0%})"
    lines = ["# ViWatch and Tsunoda et al. on the camera-timed gestures", "",
             "Camera-timed gestures: " + "; ".join(f"{d}: " + ", ".join(f"{k} {n}" for k, n in c.items()) for d, c in counts.items()) + ".",
             "Thresholds set so each paper's own segmentation lands on the most camera-timed gestures.", "",
             "## ViWatch, within the two days (3:1:1; pinch, fist, hand open)", "",
             f"{w['segments']} segments (" + ", ".join(f"{k} {v}" for k, v in w["per_class"].items())
             + f"); {w['matched_share']:.0%} of camera-timed gestures got a segment.", "",
             "| | Accuracy | Balanced accuracy | Always the largest class |", "|---|---:|---:|---:|",
             f"| Backbone CNN | {w['accuracy']:.0%} | {w['balanced']:.0%} | {w['majority']:.0%} |", "",
             "## ViWatch, each day held out (pinch against fist)", "",
             "| Held-out day | Test (pinch / fist) | Always the largest class | Backbone | DANN | Siamese DANN |", "|---|---|---:|---|---|---|"]
    for d in DAYS:
        v = results["viwatch"][d]
        lines.append(f"| {d} | {v['test_pinch']} / {v['test_fist']} | {v['majority']:.0%} | {cell(v['backbone'])} | {cell(v['DANN'])} | {cell(v['Siamese DANN'])} |")
    lines += ["", "## Tsunoda et al., each day held out (pinch against fist)", "",
              "| Held-out day | Test (pinch / fist) | Always the largest class | SVM on all training gestures | 5 a gesture | 10 a gesture |", "|---|---|---:|---|---|---|"]
    for d in DAYS:
        v = results["tsunoda"][d]
        lines.append(f"| {d} | {v['test_pinch']} / {v['test_fist']} | {v['majority']:.0%} | {cell(v['all'])} | {cell(v['5 a gesture'])} | {cell(v['10 a gesture'])} |")
    lines += ["", f"{results['seconds']} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
