"""Why does ViWatch, as published, barely separate pinch from fist on these recordings? One change at a time.

`paper_viwatch_check.py` replicates ViWatch (UIST 2023) as published. This diagnostic is not part of that replication:
it reruns the same backbone CNN on the same leave-one-day-out task (pinch against fist; the same segmentation,
alignment, architecture, training and best-on-validation rule), changing one step at a time to see which one costs the
accuracy:

* **as published**: the reference;
* **no 20 Hz high-pass**: the segments are cut from the unfiltered motion, so the slow wrist and tendon motion of a
  fist stays in;
* **no per-segment z-score**: the segments keep their size (each axis scaled by the training segments' spread, one
  number per axis, so a pinch and a fist can still differ in strength);
* **neither**: both changes;
* **class weights**: as published, with the loss weighted by inverse class frequency (pinches outnumber fists about 3
  to 1).

Scores: accuracy and balanced accuracy (the mean of each class's recall; 50% is chance), the mean of 3 training runs
per day (the replication used 5; seeds are its first 3).

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/paper_viwatch_diagnostic.py

Run from the repository root (about an hour). Writes paper-viwatch-diagnostic/results.json and results.md.
"""
import copy, importlib.util, json, time
from pathlib import Path
import numpy as np
import torch
from torch import nn

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("paper_viwatch_check", HERE / "paper_viwatch_check.py")
V = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(V)
M = V.M

RUNS = 3
VARIANTS = {"as published": ("hp100", True, False), "no 20 Hz high-pass": ("x100", True, False),
            "no per-segment z-score": ("hp100", False, False), "neither": ("x100", False, False),
            "class weights": ("hp100", True, True)}


def raw_segments(r, items, key):
    n = int(V.SEGMENT_S * V.HZ)
    return np.stack([r[key][s:s + n + V.MAX_SHIFT] for s, _ in items])


def finish(raw, template, zscore, axis_scale):
    """As `paper_viwatch_check.finish`, with the per-segment z-score optional."""
    out = []
    for seg in raw:
        m = np.linalg.norm(seg[:, :3], axis=1)
        cc = [np.dot(m[s:s + V.TIMESTEPS] - m[s:s + V.TIMESTEPS].mean(), template) for s in range(V.MAX_SHIFT + 1)]
        s = int(np.argmax(cc))
        w = seg[s:s + V.TIMESTEPS]
        out.append((((w - w.mean(0)) / (w.std(0) + 1e-8)) if zscore else (w - w.mean(0)) / axis_scale).T)
    return np.array(out, dtype=np.float32)


def train(X, y, seed, weighted):
    """`paper_viwatch_check.train_backbone`, with optional class weights."""
    torch.manual_seed(seed); rng = np.random.default_rng(seed)
    idx = rng.permutation(len(y)); nv = max(1, len(y) // 5)
    va, tr = idx[:nv], idx[nv:]
    ext = V.Extractor(); width = ext(torch.zeros(1, 6, V.TIMESTEPS)).shape[1]
    clf = V.Classifier(width, 2)
    opt = torch.optim.Adam(list(ext.parameters()) + list(clf.parameters()), lr=V.LR)
    counts = np.bincount(y[tr], minlength=2)
    weight = torch.tensor(len(tr) / (2 * np.maximum(counts, 1)), dtype=torch.float32) if weighted else None
    best, state = -1.0, None
    Xt, yt = torch.from_numpy(X), torch.from_numpy(y).long()
    for _ in range(V.EPOCHS):
        ext.train(); clf.train()
        order = rng.permutation(tr)
        for b in range(0, len(order), V.BATCH):
            pick = order[b:b + V.BATCH]
            if len(pick) < 2:
                continue
            loss = nn.functional.nll_loss(clf(ext(Xt[pick])), yt[pick], weight=weight)
            opt.zero_grad(); loss.backward(); opt.step()
        v = float((V.accuracy((ext, clf), X[va], y[va]) == y[va]).mean())
        if v > best:
            best, state = v, (copy.deepcopy(ext.state_dict()), copy.deepcopy(clf.state_dict()))
    ext.load_state_dict(state[0]); clf.load_state_dict(state[1])
    return ext, clf


def main():
    t0 = time.time()
    torch.set_num_threads(8)
    out_dir = HERE / "paper-viwatch-diagnostic"; out_dir.mkdir(exist_ok=True)
    recs = M.load_all()
    for r in recs:
        V.upsample(r)
    results = {name: {} for name in VARIANTS}
    for day in V.DAYS:
        train_recs = [r for r in recs if r["day"] in V.DAYS and r["day"] != day]
        test_recs = [r for r in recs if r["day"] == day]
        high = float(np.quantile([e for r in train_recs for e in V.gesture_peak_energy(r, V.CLASSES_DAYS)], 1 - V.DETECT_SHARE))
        tr_items = [(r, s, c) for r in train_recs for s, c in V.labelled(r, V.segments(r, high), V.CLASSES_DAYS)]
        te_items = [(r, s, c) for r in test_recs for s, c in V.labelled(r, V.segments(r, high), V.CLASSES_DAYS)]
        ytr = np.array([c for *_, c in tr_items]); yte = np.array([c for *_, c in te_items])
        for name, (key, zscore, weighted) in VARIANTS.items():
            raw_tr = np.concatenate([raw_segments(r, [(s, c)], key) for r, s, c in tr_items])
            raw_te = np.concatenate([raw_segments(r, [(s, c)], key) for r, s, c in te_items])
            tmpl = V.template_of(raw_tr)
            axis_scale = raw_tr.reshape(-1, 6).std(0) + 1e-8
            Xtr, Xte = finish(raw_tr, tmpl, zscore, axis_scale), finish(raw_te, tmpl, zscore, axis_scale)
            got = []
            for run in range(RUNS):
                seed = M.SEED + run
                # The same test half as the replication's backbone column.
                half = np.random.default_rng(seed).permutation(len(yte))
                T_test = half[len(half) // 2:]
                model = train(Xtr, ytr, seed, weighted)
                got.append(V.scores(V.accuracy(model, Xte[T_test], yte[T_test]), yte[T_test], 2))
            results[name][day] = {"accuracy": float(np.mean([a for a, _ in got])), "balanced": float(np.mean([b for _, b in got])),
                                  "test_pinch": int((yte == 0).sum()), "test_fist": int((yte == 1).sum())}
            print(f"day {day}, {name}: {results[name][day]}", flush=True)
    out = {"variants": results, "seconds": round(time.time() - t0, 1)}
    (out_dir / "results.json").write_text(json.dumps(out, indent=1))
    lines = ["# ViWatch on these recordings: which step costs the accuracy?", "",
             "Leave one day out, pinch against fist; balanced accuracy (50% is chance), with accuracy in brackets. Mean of 3 runs.", "",
             "| Variant | " + " | ".join(V.DAYS) + " | Mean balanced |", "|---|" + "---|" * len(V.DAYS) + "---:|"]
    for name, per in results.items():
        lines.append(f"| {name} | " + " | ".join(f"{per[d]['balanced']:.0%} ({per[d]['accuracy']:.0%})" for d in V.DAYS)
                     + f" | {np.mean([per[d]['balanced'] for d in V.DAYS]):.0%} |")
    lines += ["", f"{out['seconds']} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
