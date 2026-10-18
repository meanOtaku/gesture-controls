"""All 26 derivative-input method families on any causal preprocessing stage, reimplemented from the method ledger.

Stages (see reproduce.py): A raw, B 1-second z-score, C z-score -> sigmoid, D z-score -> sigmoid -> median/MAD.
The archive ran all 26 on A (ppg-derivatives-all-techniques/) and D (ppg-zsig-mad-derivatives-all/); running those
stages here checks this implementation against them, and B and C rank the 26 without the MAD step.

    uv run --project tools/label-trainer --extra torch python docs/research/artifacts/ppg-benchmark-2026-10/benchmark_all.py \
        --stages A B C D [--methods extra_trees dense_mlp ...] [--out out_dir]

Run from the repository root. Each stage takes several minutes; writes stage-<S>.json and comparison.md to --out.
"""
import argparse, importlib.util, json, tempfile, time
from pathlib import Path
import numpy as np
import torch
from torch import nn
from scipy.special import expit
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier
from sklearn.feature_selection import SelectKBest, f_classif
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.preprocessing import RobustScaler, StandardScaler

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("reproduce", HERE / "reproduce.py")
R = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(R)

SEED = 17
N_STATS, N_WIN, N_CH, N_ORD, LAGS = 21, 3, 3, 3, 33
ARCHIVED = {"A": HERE / "ppg-derivatives-all-techniques/scores.json", "D": HERE / "ppg-zsig-mad-derivatives-all/scores.json"}
METHODS = {m["id"]: m for m in json.loads((HERE / "ppg-zsig-mad-derivatives-all/method-ledger.json").read_text())["methods"]}
torch.set_num_threads(4)


# ---------- inputs: ordered derivative traces (N, 9, 33) and the 567 summaries ----------
def ordered(D, ticks):
    """Derivative-major traces: row k = order*3 + channel, 33 chronological samples ending at each tick."""
    idx = ticks[:, None] + np.arange(-LAGS + 1, 1)[None, :]
    return np.stack([D[o, c][idx] for o in range(N_ORD) for c in range(N_CH)], axis=1)

def summary(O):
    """The 567 ablation summaries (order, window, stat, channel) from ordered traces."""
    cols = []
    for o in range(N_ORD):
        for win in R.WINDOWS:
            per_ch = [R.summarize(O[:, o * 3 + c, -win:]) for c in range(N_CH)]
            cols.append(np.stack(per_ch, axis=2).reshape(len(O), -1))
    return np.concatenate(cols, axis=1)

def stat_columns(stats):
    return [o * 189 + w * 63 + s * 3 + c for o in range(N_ORD) for w in range(N_WIN) for s in stats for c in range(N_CH)]

def correlations(O):
    """Within-order pairwise RGB correlations of the final 32 derivative samples (9 features)."""
    X = O[:, :, -32:]; X = X - X.mean(2, keepdims=True)
    sd = np.sqrt((X ** 2).sum(2))
    out = []
    for o in range(N_ORD):
        for a, b in ((0, 1), (0, 2), (1, 2)):
            i, j = o * 3 + a, o * 3 + b
            den = sd[:, i] * sd[:, j]
            out.append(np.where(den > 0, (X[:, i] * X[:, j]).sum(1) / np.where(den > 0, den, 1), 0.0))
    return np.stack(out, 1)

def haar(O):
    """Adjacent non-overlapping block-mean differences (later minus earlier) at scales 1..16 on the final 32 samples."""
    X = O[:, :, -32:]; out = []
    for s in (1, 2, 4, 8, 16):
        blocks = X.reshape(len(X), X.shape[1], 32 // s, s).mean(3)
        out.append((blocks[:, :, 1::2] - blocks[:, :, 0::2]).reshape(len(X), -1))
    return np.concatenate(out, 1)

def method_input(m, S, O):
    """Feature matrix a method's estimator sees (before training-fitted scaling); `ordered` methods get flat traces."""
    if m["feature"] == "ordered":
        return O.reshape(len(O), -1)
    X = S if m.get("stats") is None else S[:, stat_columns(m["stats"])]
    if m.get("corr"):
        X = np.concatenate([X, correlations(O)], 1)
    if m.get("haar"):
        X = np.concatenate([X, haar(O)], 1)
    return X


# ---------- augmentation in derivative space ----------
def augment(Xflat, rng, copies=2):
    O = Xflat.reshape(len(Xflat), N_ORD * N_CH, LAGS)
    sd = O.transpose(1, 0, 2).reshape(N_ORD * N_CH, -1).std(1)                  # per derivative/channel, pooled
    out = [O]
    for _ in range(copies):
        gain = rng.uniform(.8, 1.2, (len(O), N_CH))
        A = O * np.tile(gain, N_ORD)[:, :, None]                                  # one gain per physical channel
        A = A + rng.normal(0, 1, A.shape) * (.05 * sd)[None, :, None]
        drop = rng.random(len(O)) < .15
        ch = rng.integers(0, N_CH, len(O))
        for i in np.flatnonzero(drop):
            A[i, [o * 3 + ch[i] for o in range(N_ORD)]] = 0.0
        out.append(A)
    return np.concatenate(out).reshape(-1, N_ORD * N_CH * LAGS)


# ---------- estimators ----------
def lr():
    return LogisticRegression(C=1, max_iter=5000, solver="lbfgs", random_state=SEED)

class Linear:
    def __init__(self, m): self.m = m
    def _post(self, Z):
        post = self.m.get("post")
        if post == "sigmoid": return expit(Z)
        if post == "round6": return np.round(Z, 6)
        if post == "sigmoid4": return np.round(expit(Z), 4)
        if post == "sigmoid6": return np.round(expit(Z), 6)
        return Z
    def fit(self, X, y, groups):
        w = None
        if self.m.get("balanced"):
            _, inv, cnt = np.unique(groups, return_inverse=True, return_counts=True); w = 1.0 / cnt[inv]; w = w * len(w) / w.sum()
        if self.m.get("augment"):
            X = summary(augment(X, np.random.default_rng(SEED)).reshape(-1, 9, LAGS)); y = np.tile(y, 3)
        self.scaler = RobustScaler().fit(X) if self.m.get("scaler") == "robust" else StandardScaler().fit(X, sample_weight=w)
        Z = self._post(self.scaler.transform(X))
        self.select = SelectKBest(f_classif, k=self.m["select"]).fit(Z, y) if self.m.get("select") else None
        if self.select is not None: Z = self.select.transform(Z)
        self.model = lr().fit(Z, y, sample_weight=w)
        return self
    def predict(self, X):
        if self.m.get("augment"): X = summary(X.reshape(-1, 9, LAGS))
        Z = self._post(self.scaler.transform(X))
        if self.select is not None: Z = self.select.transform(Z)
        return self.model.predict_proba(Z)[:, 1]

class LOSO:
    def fit(self, X, y, groups):
        self.members = []
        for g in np.unique(groups):
            keep = groups != g
            sc = StandardScaler().fit(X[keep])
            self.members.append((sc, lr().fit(sc.transform(X[keep]), y[keep])))
        return self
    def predict(self, X):
        return np.mean([m.predict_proba(sc.transform(X))[:, 1] for sc, m in self.members], 0)

class Tree:
    def __init__(self, kind): self.kind = kind
    def fit(self, X, y, groups):
        self.scaler = StandardScaler().fit(X)
        self.model = (HistGradientBoostingClassifier(max_iter=150, learning_rate=0.05, max_leaf_nodes=15, l2_regularization=1,
                                                     min_samples_leaf=20, early_stopping=False, random_state=SEED)
                      if self.kind == "hgb" else
                      ExtraTreesClassifier(n_estimators=300, min_samples_leaf=3, max_features=0.7, n_jobs=-1, random_state=SEED))
        self.model.fit(self.scaler.transform(X), y); return self
    def predict(self, X):
        return self.model.predict_proba(self.scaler.transform(X))[:, 1]

class MLPNet(nn.Module):
    def __init__(self, d):
        super().__init__(); self.body = nn.Sequential(nn.Linear(d, 64), nn.ReLU(), nn.Linear(64, 32), nn.ReLU()); self.head = nn.Linear(32, 1)
    def forward(self, x):
        z = self.body(x); return self.head(z).squeeze(1), z

class CNNNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.c1 = nn.Conv1d(9, 24, 5); self.c2 = nn.Conv1d(24, 32, 5, dilation=2); self.head = nn.Linear(32, 1)
    def forward(self, x):
        x = torch.relu(self.c1(nn.functional.pad(x, (4, 0))))
        x = torch.relu(self.c2(nn.functional.pad(x, (8, 0))))
        z = x.mean(2); return self.head(z).squeeze(1), z

class Neural:
    def __init__(self, m): self.m = m
    def fit(self, X, y, groups):
        torch.manual_seed(SEED); rng = np.random.default_rng(SEED)
        if self.m.get("augment"):
            X = augment(X, rng); y = np.tile(y, 3); groups = np.tile(groups, 3)
        self.scaler = StandardScaler().fit(X)
        Xt = torch.tensor(self._shape(self.scaler.transform(X)), dtype=torch.float32); yt = torch.tensor(y, dtype=torch.float32)
        self.net = CNNNet() if self.m["estimator"] == "cnn" else MLPNet(X.shape[1])
        opt = torch.optim.Adam(self.net.parameters(), lr=1e-3, weight_decay=1e-4)
        bce = nn.BCEWithLogitsLoss(reduction="none")
        dg = self.m.get("dg")
        _, gidx = np.unique(groups, return_inverse=True); gidx = torch.tensor(gidx); G = int(gidx.max()) + 1
        q = torch.full((G,), 1.0 / G)
        for _ in range(80):
            if dg:                                                                  # full-batch domain objectives
                logits, z = self.net(Xt); loss_i = bce(logits, yt)
                sess = torch.stack([loss_i[gidx == g].mean() for g in range(G)])
                if dg == "dro":
                    q = q * torch.exp(0.05 * sess.detach()); q = q / q.sum(); loss = (q * sess).sum()
                else:
                    covs = [torch.cov(z[gidx == g].T) for g in range(G) if int((gidx == g).sum()) >= 2]
                    mean_cov = torch.stack(covs).mean(0)
                    loss = loss_i.mean() + 0.1 * torch.stack([((c - mean_cov) ** 2).mean() for c in covs]).mean()
                opt.zero_grad(); loss.backward(); opt.step()
            else:
                perm = torch.randperm(len(Xt))
                for b in range(0, len(Xt), 128):
                    i = perm[b:b + 128]; logits, _ = self.net(Xt[i])
                    loss = bce(logits, yt[i]).mean(); opt.zero_grad(); loss.backward(); opt.step()
        return self
    def _shape(self, X):
        return X.reshape(len(X), 9, LAGS) if self.m["estimator"] == "cnn" else X
    def predict(self, X):
        with torch.no_grad():
            return torch.sigmoid(self.net(torch.tensor(self._shape(self.scaler.transform(X)), dtype=torch.float32))[0]).numpy()

def make(m):
    e = m["estimator"]
    if e == "lr": return Linear(m)
    if e == "loso": return LOSO()
    if e in ("hgb", "trees"): return Tree(e)
    return Neural(m)


# ---------- study ----------
def prepare(stage):
    inv = {r["session_id"]: r for r in json.loads((R.ABL / "inventory.json").read_text()) if r["status"] == "included"}
    events = json.loads((R.ABL / "events.json").read_text())
    S = np.full((len(events), 567), np.nan); O = np.full((len(events), 9, LAGS), np.nan); rec = {}
    for sid, r in inv.items():
        ppg_files, label_files = R.recording_files(Path(r["path"]).name)
        ts, x = R.load_ppg(ppg_files); origin = int(ts[0])
        anchors, decisions = R.timeline(int(ts[-1]) - origin)
        starts = [s - origin for s in R.pinch_starts(label_files) if anchors[0] <= s - origin <= anchors[-1]]
        grid = R.zoh_grid(ts, x)
        D = np.stack([R.derivatives(R.stage(grid[:, c], stage)) for c in range(3)], axis=1)
        ev = [i for i, e in enumerate(events) if e["session"] == sid]
        O[ev] = ordered(D, np.array([(events[i]["decision_ns"] - origin) // R.TICK for i in ev]))
        S[ev] = summary(O[ev])
        Oa = ordered(D, decisions // R.TICK)
        rec[sid] = dict(decisions=decisions, starts=starts, minutes=(anchors[-1] - anchors[0] + R.ANCHOR_STEP) / 60e9, S=summary(Oa), O=Oa)
    assert np.isfinite(S).all() and np.isfinite(O).all() and all(np.isfinite(v["O"]).all() for v in rec.values())
    return events, S, O, rec

def run_stage(stage, methods, out):
    t0 = time.time()
    events, S, O, rec = prepare(stage)
    print(f"stage {stage}: inputs ready in {time.time() - t0:.0f}s", flush=True)
    splits = json.loads((R.ABL / "splits.json").read_text())
    y = np.array([e["y"] for e in events]); sess = np.array([e["session"] for e in events])
    res = {}
    for mid in methods:
        m = METHODS[mid]; t1 = time.time()
        X = method_input(m, S, O)
        Xrec = {sid: method_input(m, v["S"], v["O"]) for sid, v in rec.items()}
        aucs, oof_y, oof_p = [], [], []
        pooled = dict(activations=0, matched=0, starts=0, latency_sum=0, minutes=0.0)
        for sp in splits:
            tr, te = np.isin(sess, sp["train"]), np.isin(sess, sp["test"])
            model = make(m).fit(X[tr], y[tr], sess[tr])
            p = model.predict(X[te]); aucs.append(roc_auc_score(y[te], p)); oof_y.append(y[te]); oof_p.append(p)
            for sid in sp["test"]:
                for k, v in R.evaluate_timeline(model.predict(Xrec[sid]), rec[sid]["decisions"], rec[sid]["starts"]).items():
                    pooled[k] += v
                pooled["minutes"] += rec[sid]["minutes"]
        res[mid] = dict(min=min(aucs), mean=float(np.mean(aucs)), max=max(aucs),
                        pooled_auc=roc_auc_score(np.concatenate(oof_y), np.concatenate(oof_p)),
                        **R.rates(pooled), per_fold_auc=aucs, seconds=time.time() - t1)
        print(f"  {stage} {mid:28s} min {min(aucs):.4f} mean {np.mean(aucs):.4f} recall {res[mid]['recall']:.3f} "
              f"false/min {res[mid]['false_per_min']:.2f}  ({time.time() - t1:.0f}s)", flush=True)
        (out / f"stage-{stage}.json").write_text(json.dumps(res, indent=1))
    return res

def ranked(res):
    return sorted(res, key=lambda k: (-res[k]["min"], -res[k]["mean"], -res[k]["max"]))

def report(all_res, out):
    lines = []
    for stage, res in all_res.items():
        arch = {r["id"]: r for r in json.loads(ARCHIVED[stage].read_text())} if stage in ARCHIVED else {}
        lines += [f"## Stage {stage}", "", "| Rank | Method | Min AUC | Mean AUC | Max AUC | Pooled AUC | Recall | Precision | False/min |"
                  + (" Archived min / mean |" if arch else ""), "|---:|---|---:|---:|---:|---:|---:|---:|---:|" + ("---:|" if arch else "")]
        for i, k in enumerate(ranked(res), 1):
            r = res[k]
            row = f"| {i} | {k} | {r['min']:.4f} | {r['mean']:.4f} | {r['max']:.4f} | {r['pooled_auc']:.4f} | {r['recall']:.3f} | {r['precision']:.3f} | {r['false_per_min']:.2f} |"
            if arch: row += f" {arch[k]['min']:.4f} / {arch[k]['mean']:.4f} |"
            lines.append(row)
        if arch:
            d = [abs(res[k]["mean"] - arch[k]["mean"]) for k in res]
            lines += ["", f"Mean-AUC difference from the archive: median {np.median(d):.4f}, largest {max(d):.4f}."]
        lines.append("")
    (out / "comparison.md").write_text("\n".join(lines))
    print("\n".join(lines))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stages", nargs="+", default=["B", "C"])
    ap.add_argument("--methods", nargs="+", default=list(METHODS))
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args()
    out = a.out or Path(tempfile.mkdtemp(prefix="ppg-bench-")); out.mkdir(parents=True, exist_ok=True)
    report({s: run_stage(s, a.methods, out) for s in a.stages}, out)
    print(f"Wrote {out}")

if __name__ == "__main__":
    main()
