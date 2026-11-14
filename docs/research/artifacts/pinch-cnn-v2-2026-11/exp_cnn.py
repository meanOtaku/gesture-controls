"""Experiment 2+: CNN variants on the benchmark, trained the way the trainer trains (`label_trainer.cnn`): same labels,
epochs, batch, optimiser, cosine schedule, positive weight, negative cap and per-batch augmentation (size scaled, noise,
40 ms shift, pulse blanked), so that only the option under test changes.

Options:
  --arch trainer|branches  the trainer's network, or one branch per sensor (accelerometer, gyroscope, pulse) joined partway
                           (a shared convolution over the branches' maps) and at the end (each branch's pooled features beside
                           the shared ones)
  --hz 100|50              the trainer's inputs at this rate
  --jerk                   add the accelerometer's change per tick and its size as 4 channels (accelerometer branch)
  --warp                   also time-warp and magnitude-warp each batch (smooth random curves, Um et al. 2017)
  --hard                   a second training from scratch that keeps the negatives the first scored highest
  --members N              networks averaged (trainer: 3; 1 for quick screening)
  --oof                    choose the threshold out of fold (4 more trainings); otherwise compare at matched rates only
  --seed N

Run: tools/label-trainer/.venv/bin/python docs/research/artifacts/pinch-cnn-v2-2026-11/exp_cnn.py --arch branches --jerk
"""
import argparse
import os
import time

import numpy as np
import torch
from torch import nn

import bench
from label_trainer import cnn

PULSE = slice(6, 9)


def with_jerk(w: np.ndarray) -> np.ndarray:
    d = np.diff(w[:, 0:3, :], axis=2, prepend=w[:, 0:3, :1])
    return np.concatenate([w, d, np.linalg.norm(d, axis=1, keepdims=True)], axis=1)


def windows_of(x: np.ndarray, hz: int, jerk: bool) -> np.ndarray:
    w = x.reshape(len(x), 9, hz).astype(np.float32)
    return with_jerk(w).astype(np.float32) if jerk else w


def dilations(hz: int):
    return [1, 2, 4, 8] if hz == 100 else [1, 2, 4]


def conv_stack(c_in, widths, dils):
    layers = []
    for out, d in zip(widths, dils):
        layers += [nn.Conv1d(c_in, out, cnn.KERNEL, padding=d * (cnn.KERNEL - 1) // 2, dilation=d), nn.BatchNorm1d(out), nn.ReLU()]
        c_in = out
    return nn.Sequential(*layers), c_in


class TrainerNet(nn.Module):
    """The trainer's network (`cnn._net`), for any number of input channels."""

    def __init__(self, channels, hz):
        super().__init__()
        widths = [32, 32, 32, 64] if hz == 100 else [32, 32, 64]
        self.body, c = conv_stack(channels, widths, dilations(hz))
        self.head = nn.Sequential(nn.Linear(2 * c, cnn.HIDDEN), nn.ReLU(), nn.Dropout(0.2), nn.Linear(cnn.HIDDEN, 1))

    def forward(self, x):
        h = self.body(x)
        return self.head(torch.cat([h.amax(2), h.mean(2)], 1)).squeeze(1)


class BranchNet(nn.Module):
    """One branch per sensor, joined partway and at the end."""

    def __init__(self, channels, hz):
        super().__init__()
        accel = [0, 1, 2] + list(range(9, channels))      # jerk channels go with the accelerometer
        self.groups = [accel, [3, 4, 5], [6, 7, 8]]
        d = dilations(hz)
        self.branches = nn.ModuleList([conv_stack(len(g), [16, 16], d[:2])[0] for g in self.groups])
        self.shared, c = conv_stack(16 * len(self.groups), [32, 64] if hz == 100 else [64], d[2:])
        late = 2 * 16 * len(self.groups) + 2 * c
        self.head = nn.Sequential(nn.Linear(late, cnn.HIDDEN), nn.ReLU(), nn.Dropout(0.2), nn.Linear(cnn.HIDDEN, 1))

    def forward(self, x):
        maps = [b(x[:, g, :]) for b, g in zip(self.branches, self.groups)]
        h = self.shared(torch.cat(maps, 1))
        pooled = [torch.cat([m.amax(2), m.mean(2)], 1) for m in maps] + [torch.cat([h.amax(2), h.mean(2)], 1)]
        return self.head(torch.cat(pooled, 1)).squeeze(1)


def smooth_curves(n, channels, ticks, sigma, knots, generator, device):
    """Per window and channel, a smooth curve around 1 (cubic-ish interpolation of random knots)."""
    k = 1.0 + sigma * torch.randn(n, channels, knots, generator=generator, device=device)
    return nn.functional.interpolate(k, size=ticks, mode="linear", align_corners=True)


def augmented(w, generator, warp: bool):
    """`cnn._augmented` for any channel count (pulse = channels 6-8), plus optional time and magnitude warping."""
    logit = torch.logit(w.clamp(1e-5, 1 - 1e-5))
    n, channels, ticks = logit.shape
    low, high = cnn.AUGMENT_SCALE
    logit = logit * torch.empty(n, channels, 1, device=w.device).uniform_(low, high, generator=generator)
    logit = logit + cnn.AUGMENT_NOISE * torch.randn(logit.shape, device=w.device, generator=generator)
    if warp:
        logit = logit * smooth_curves(n, channels, ticks, 0.2, 4, generator, w.device)
        speed = smooth_curves(n, 1, ticks, 0.25, 4, generator, w.device).clamp(0.3, 3.0)[:, 0, :]
        pos = torch.cumsum(speed, 1)
        pos = (pos - pos[:, :1]) / (pos[:, -1:] - pos[:, :1]).clamp_min(1e-6) * (ticks - 1)
        src = pos.round().long().clamp(0, ticks - 1)
        logit = torch.gather(logit, 2, src[:, None, :].expand(-1, channels, -1))
    most = round(cnn.AUGMENT_SHIFT_MS * ticks / 1000)
    shifts = torch.randint(-most, most + 1, (n,), device=w.device, generator=generator)
    source = (torch.arange(ticks, device=w.device)[None, :] - shifts[:, None]).clamp(0, ticks - 1)
    logit = torch.gather(logit, 2, source[:, None, :].expand(-1, channels, -1))
    blank = torch.rand(n, device=w.device, generator=generator) < cnn.AUGMENT_PULSE_BLANK
    logit[blank, PULSE, :] = 0.0
    return torch.sigmoid(logit)


def train_one(net, w, y, seed, warp, epochs=cnn.EPOCHS, keep=None):
    """`cnn._train` with this file's augmentation; rows `keep` marks (hard negatives) are never left out by the cap."""
    rng = np.random.default_rng(seed)
    kept = np.zeros(len(y), dtype=bool) if keep is None else keep
    neg = np.flatnonzero((y == 0) & ~kept)
    room = max(0, cnn.MAX_NEGATIVES - int(((y == 0) & kept).sum()))
    if len(neg) > room:
        rows = np.sort(np.concatenate([np.flatnonzero((y == 1) | kept), rng.choice(neg, room, replace=False)]))
        w, y = w[rows], y[rows]
    where = cnn.device()
    net.to(where)
    xw = torch.from_numpy(w).to(where)
    truth = torch.from_numpy(y.astype(np.float32)).to(where)
    opt = torch.optim.Adam(net.parameters(), lr=cnn.LEARNING_RATE, weight_decay=cnn.WEIGHT_DECAY)
    pos = max(1.0, float(y.sum()))
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(min(cnn.MAX_POSITIVE_WEIGHT, (len(y) - pos) / pos), device=where))
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, max(1, epochs * ((len(y) + cnn.BATCH - 1) // cnn.BATCH)))
    gen = torch.Generator(device=where).manual_seed(int(rng.integers(2**31)))
    for _ in range(epochs):
        net.train()
        order = torch.from_numpy(rng.permutation(len(y))).to(where)
        for b in range(0, len(order), cnn.BATCH):
            pick = order[b:b + cnn.BATCH]
            if len(pick) < 2:
                continue
            loss = loss_fn(net(augmented(xw[pick], gen, warp)), truth[pick])
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    return net.to("cpu").eval()


def make_fit(a):
    def fit(data: bench.Data):
        t0 = time.time()
        w = windows_of(data.x, a.hz, a.jerk)
        y = data.y.astype(np.int64)

        def train(keep=None):
            nets = []
            for m in range(a.members):
                torch.manual_seed(a.seed + m)
                net = (BranchNet if a.arch == "branches" else TrainerNet)(w.shape[1], a.hz)
                nets.append(train_one(net, w, y, a.seed + m, a.warp, keep=keep))
            return nets

        nets = train()
        if a.hard:
            # Hard negatives: the training negatives the first networks scored highest, kept in a second training from
            # scratch (as MiniRocket's --hard; the trainer's own pass adds only the moments it fired on).
            scores = score_with(nets, data.x)
            neg = np.flatnonzero(y == 0)
            top = neg[np.argsort(scores[neg])[::-1][:2 * int(y.sum())]]
            keep = np.zeros(len(y), dtype=bool); keep[top] = True
            nets = train(keep)
        print(f"  trained {a.members} network(s) on {len(w)} moments in {time.time() - t0:.0f} s", flush=True)
        return lambda x: score_with(nets, x)

    def score_with(nets, x):
        ww = torch.from_numpy(windows_of(x, a.hz, a.jerk))
        where = cnn.device()
        p = np.zeros(len(ww))
        with torch.no_grad():
            for net in nets:
                net.to(where).eval()
                for i in range(0, len(ww), 4096):
                    p[i:i + 4096] += torch.sigmoid(net(ww[i:i + 4096].to(where))).cpu().numpy()
                net.to("cpu")
        return p / len(nets)
    return fit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", default="trainer", choices=["trainer", "branches"])
    ap.add_argument("--hz", type=int, default=100, choices=[50, 100])
    ap.add_argument("--jerk", action="store_true")
    ap.add_argument("--warp", action="store_true")
    ap.add_argument("--hard", action="store_true")
    ap.add_argument("--members", type=int, default=1)
    ap.add_argument("--oof", action="store_true")
    ap.add_argument("--seed", type=int, default=17)
    a = ap.parse_args()
    name = (f"cnn-{a.arch}-{a.hz}hz" + ("-jerk" if a.jerk else "") + ("-warp" if a.warp else "") + ("-hard" if a.hard else "")
            + f"-m{a.members}" + (f"-s{a.seed}" if a.seed != 17 else "")
            + (f"-data-{os.environ['BENCH_TRAIN']}" if os.environ.get("BENCH_TRAIN") else ""))
    data = bench.training_data(hz=a.hz)
    print(f"{name}: {len(data.y)} training moments, {int(data.y.sum())} positive", flush=True)
    fit = make_fit(a)
    chosen = None
    if a.oof:
        chosen, replay = bench.choose_threshold_oof(fit, data, hz=a.hz)
        print(f"  threshold chosen out of fold: {chosen}", flush=True)
    predict = fit(data)
    res = bench.score(predict, hz=a.hz)
    bench.save(name, res, chosen, vars(a), notes=f"CNN `{a.arch}` at {a.hz} Hz" + (", jerk channels" if a.jerk else "")
               + (", time and magnitude warping" if a.warp else "") + f", {a.members} network(s), seed {a.seed}, "
               + ("retrained with hard negatives." if a.hard else "trained like the trainer (no hard-negative pass).") + ("" if a.oof else " No out-of-fold threshold: compare at matched rates."))


if __name__ == "__main__":
    main()
