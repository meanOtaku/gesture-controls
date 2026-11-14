"""Does a better training loop, augmentation, or the full 100 Hz motion signal make the pinch CNN catch more?

Every variant trains on the 22 recordings the live `pinch_in-motion` / `pinch_out-motion` models trained on and is scored on
11 it never saw: the 8 held out when those models were made, and the three hand-labelled sessions of 9 Nov (13:48, 13:51,
13:54). All are under `data/recordings/Hand labeled/`.

Variants (each two seeds, three networks a seed, as the trainer does):

* `base`      the trainer as it was when this ran (12 Nov): 12 passes, Adam at 0.001, gesture moments weighted up to 20
              times. The trainer has since taken `loop+aug` as its own loop (`cnn._train`), so running `base` again
              trains that, and the results here are the record of the comparison.
* `loop`      gesture moments weighted 3 times at most, 20 passes, the learning rate following a cosine down to zero.
* `aug`       `base` for 20 passes, each batch changed a little: its size scaled, noise added, moved up to 40 ms in time,
              and the pulse blanked in 15% of the windows.
* `loop+aug`  both.
* `...@100`   the same on a 100 Hz grid (the rate the watch sends motion at; the trainer uses every other sample), with a
              fourth convolution so the filters reach as far in time.
* `...@2s`    the same on a 2 s window ending at the same moment (so it decides no later), with a fourth convolution
              (dilation 8) so the filters reach 1.2 s: the "wide" window of `cnn-all-days-2026-11`.

Seeds differ by as much as the variants do, so `SEEDS=17,18,19,20,21,22` runs more of them.

A variant is judged on all 11 recordings together by the most pinches it can catch at 2, 5 and 10 false activations an hour
with no gesture under way, at whichever cut-off does best for it. That cut-off is chosen on the scored recordings, so the
numbers flatter every variant equally and are only for comparing them; they are not what a shipped model would do.

    tools/label-trainer/.venv/bin/python docs/research/artifacts/training-improvements-2026-11/experiment.py pinch_in [variant...]

Results add to `results-<target>.json` (a variant and seed already there is skipped) and `results-<target>.md` is rewritten.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tools" / "label-trainer" / "src"))

from label_trainer import cnn, cnn_input, label_train as lt  # noqa: E402

HERE = Path(__file__).resolve().parent
RECORDINGS = ROOT / "data" / "recordings" / "Hand labeled"
UNSEEN = ("pinch_hold-2026-11-09T13-48-35.709Z", "pinch_hold-2026-11-09T13-51-14.408Z", "pinch_hold-2026-11-09T13-54-14.793Z")
import os  # noqa: E402

# Two seeds by default; `SEEDS=17,18,19,20` runs more, which the spread between seeds calls for.
SEEDS = tuple(int(seed) for seed in os.environ.get("SEEDS", "17,18").split(","))
BUDGETS = (2.0, 5.0, 10.0)
THRESHOLDS = tuple(round(t, 3) for t in (*np.arange(0.30, 0.951, 0.05), 0.96, 0.97, 0.98, 0.99, 0.995, 0.999))
OTHERS = ["pinch_hold", "fist", "hand_open", "everyday_noise", "still", "supported"]


def spec_for(target: str) -> lt.Spec:
    provenance = json.loads((ROOT / "trained-models" / "pinch_in-motion" / "manifest.json").read_text())["provenance"]
    train = list(provenance["trainRecordings"])
    held_out = list(provenance["evaluationRecordings"]) + [f"gesture-dataset-{name}" for name in UNSEEN]
    ids = train + held_out
    other = "pinch_out" if target == "pinch_in" else "pinch_in"
    return lt.parse_spec({
        "version": 1, "target": target, "negatives": [other, *OTHERS], "excludes": ["left_out"],
        "recordings": {rid: str(RECORDINGS / rid) for rid in ids}, "train": train, "evaluation": held_out,
        "sources": list(lt.MOTION_SOURCES), "backend": lt.CNN_BACKEND, "seed": SEEDS[0], "research": False, "labelOffsetMs": 0,
        "labelTiming": {rid: "camera" if "pinch" in rid else "noGesture" for rid in ids}, "steadyStarts": False,
        "hardNegatives": False,
        # These variants were run on the trainer's 50 Hz grid; the trainer now defaults to 100 Hz, so it is named here.
        "motionHz": 50,
    })


def at_100_hz() -> None:
    """The input on a 100 Hz grid: the same second seen and the same 10 s scaled against, twice as many ticks."""
    cnn_input.TICK_NS = 10_000_000
    cnn_input.WINDOW_TICKS, cnn_input.HISTORY_TICKS = 100, 1000
    cnn_input.GRID_TICKS = cnn_input.WINDOW_TICKS + cnn_input.HISTORY_TICKS - 1
    cnn_input.SPAN_NS = (cnn_input.GRID_TICKS - 1) * cnn_input.TICK_NS
    cnn_input.MOVING_RMS_TICKS, cnn_input.MOVING_MARGIN_TICKS = 30, 50
    cnn_input.FEATURE_NAMES = tuple(f"cnn_{c}_t{t:03d}" for c in cnn_input.CHANNELS for t in range(cnn_input.WINDOW_TICKS))
    cnn_input.FEATURE_COUNT = len(cnn_input.FEATURE_NAMES)
    cnn.LENGTH = cnn_input.WINDOW_TICKS
    cnn.CONVOLUTIONS = ((32, 1), (32, 2), (32, 4), (64, 8))


def at_2_s() -> None:
    """The input over 2 s instead of 1, on the same 50 Hz grid, and a network whose filters reach 1.2 s."""
    cnn_input.WINDOW_TICKS = 100
    cnn_input.GRID_TICKS = cnn_input.WINDOW_TICKS + cnn_input.HISTORY_TICKS - 1
    cnn_input.SPAN_NS = (cnn_input.GRID_TICKS - 1) * cnn_input.TICK_NS
    cnn_input.FEATURE_NAMES = tuple(f"cnn_{c}_t{t:03d}" for c in cnn_input.CHANNELS for t in range(cnn_input.WINDOW_TICKS))
    cnn_input.FEATURE_COUNT = len(cnn_input.FEATURE_NAMES)
    cnn.LENGTH = cnn_input.WINDOW_TICKS
    cnn.CONVOLUTIONS = ((32, 1), (32, 2), (64, 4), (64, 8))


INPUTS = {"": None, "@100": at_100_hz, "@2s": at_2_s}


def base_of(name: str) -> tuple[str, str]:
    """A variant's training changes and its input: `loop+aug@2s` is (`loop+aug`, `@2s`)."""
    for suffix in ("@100", "@2s"):
        if name.endswith(suffix):
            return name.removesuffix(suffix), suffix
    return name, ""


def augmented(windows, generator, shift_ticks: int):
    """A batch (windows x channels x ticks, each value in 0..1) changed as another wearing of the watch might change it."""
    import torch

    logit = torch.logit(windows.clamp(1e-5, 1 - 1e-5))
    n, channels, _ = logit.shape
    scale = torch.empty(n, channels, 1, device=logit.device).uniform_(0.8, 1.25, generator=generator)
    logit = logit * scale + 0.15 * torch.randn(logit.shape, device=logit.device, generator=generator)
    shifts = torch.randint(-shift_ticks, shift_ticks + 1, (n,), device=logit.device, generator=generator)
    ticks = torch.arange(logit.shape[2], device=logit.device)[None, :] - shifts[:, None]
    logit = torch.gather(logit, 2, ticks.clamp(0, logit.shape[2] - 1)[:, None, :].expand(-1, channels, -1))
    blank = torch.rand(n, device=logit.device, generator=generator) < 0.15
    logit[blank, 6:9, :] = 0.0
    return torch.sigmoid(logit)


def fit(x: np.ndarray, y: np.ndarray, seed: int, *, loop: bool, augment: bool) -> cnn.Model:
    """`cnn.fit`, with the changes a variant asks for."""
    import torch
    from torch import nn

    if not loop and not augment:
        return cnn.fit(x, y, seed)
    epochs = 20
    where = cnn.device()
    nets = []
    for member in range(cnn.MEMBERS):
        rng = np.random.default_rng(seed + member)
        net = cnn._new_net(seed + member).to(where)
        negatives = np.flatnonzero(y == 0)
        if len(negatives) > cnn.MAX_NEGATIVES:
            rows = np.sort(np.concatenate([np.flatnonzero(y == 1), rng.choice(negatives, cnn.MAX_NEGATIVES, replace=False)]))
        else:
            rows = np.arange(len(y))
        windows = torch.from_numpy(np.asarray(x[rows], dtype=np.float32).reshape(-1, cnn.CHANNELS, cnn.LENGTH)).to(where)
        truth = torch.from_numpy(y[rows].astype(np.float32)).to(where)
        positives = max(1.0, float(truth.sum()))
        weight = min(3.0 if loop else cnn.MAX_POSITIVE_WEIGHT, (len(truth) - positives) / positives)
        loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(weight, device=where))
        optimiser = torch.optim.Adam(net.parameters(), lr=cnn.LEARNING_RATE, weight_decay=cnn.WEIGHT_DECAY)
        steps = epochs * ((len(truth) + cnn.BATCH - 1) // cnn.BATCH)
        schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimiser, steps) if loop else None
        generator = torch.Generator(device=where).manual_seed(seed + member)
        for _ in range(epochs):
            net.train()
            order = torch.from_numpy(rng.permutation(len(truth))).to(where)
            for b in range(0, len(order), cnn.BATCH):
                pick = order[b:b + cnn.BATCH]
                if len(pick) < 2:
                    continue
                batch = augmented(windows[pick], generator, round(40_000_000 / cnn_input.TICK_NS)) if augment else windows[pick]
                loss = loss_fn(net(batch), truth[pick])
                optimiser.zero_grad()
                loss.backward()
                optimiser.step()
                if schedule:
                    schedule.step()
        nets.append(net.to("cpu").eval())
    return cnn.Model(nets)


def judged(spec: lt.Spec, recordings, scored: dict[str, tuple[np.ndarray, np.ndarray]]) -> dict:
    """The replay at every cut-off over all the scored recordings, and the best catch within each budget."""
    curve = []
    for threshold in THRESHOLDS:
        per = [(rid, lt.detections(spec, recordings[rid], times, scores, lt.policy_for(threshold, spec.trigger)))
               for rid, (times, scores) in scored.items()]
        total = lt.summarise([r for _, r in per])
        unseen = lt.summarise([r for rid, r in per if rid.endswith(UNSEEN)])
        curve.append({"threshold": threshold, "caught": total["caught"], "gestures": total["gestures"],
                      "falseActivations": total["falseActivations"], "perHour": total["falseActivationsPerHour"],
                      "unseenCaught": unseen["caught"], "unseenGestures": unseen["gestures"],
                      "unseenFalse": unseen["falseActivations"], "medianLatencyMs": total.get("medianLatencyMs")})
    best = {}
    for budget in BUDGETS:
        within = [point for point in curve if point["perHour"] is not None and point["perHour"] <= budget]
        best[str(budget)] = max(within, key=lambda p: (p["caught"], p["threshold"])) if within else None
    return {"curve": curve, "best": best}


VARIANTS = {
    "base": dict(loop=False, augment=False), "loop": dict(loop=True, augment=False),
    "aug": dict(loop=False, augment=True), "loop+aug": dict(loop=True, augment=True),
}


def report(target: str, results: dict) -> None:
    lines = [f"# Training variants for `{target}`", "",
             "Pinches caught of those in the 11 recordings no variant trained on, at the cut-off that catches the most within each",
             "budget of false activations an hour (chosen on these recordings: for comparing variants only). In brackets, of the",
             "three sessions of 9 Nov alone. See `experiment.py`.", "",
             "| variant | seed | " + " | ".join(f"within {b:g} an hour" for b in BUDGETS) + " |", "|---|---:|" + "---|" * len(BUDGETS)]
    for name in sorted(results, key=lambda n: (base_of(n)[1], n)):
        for seed, run in sorted(results[name].items(), key=lambda item: int(item[0])):
            cells = []
            for budget in BUDGETS:
                point = run["best"][str(budget)]
                cells.append("none" if point is None else
                             f"{point['caught']}/{point['gestures']} ({point['unseenCaught']}/{point['unseenGestures']}) at {point['threshold']:g}")
            lines.append(f"| {name} | {seed} | " + " | ".join(cells) + " |")
    (HERE / f"results-{target}.md").write_text("\n".join(lines) + "\n")


def main(target: str, wanted: list[str]) -> None:
    path = HERE / f"results-{target}.json"
    results = json.loads(path.read_text()) if path.exists() else {}
    names = wanted or [f"{name}{suffix}" for suffix in INPUTS for name in VARIANTS]
    # One process holds one input (the constants are changed in place), so each input's variants run in a process of
    # their own.
    inputs = {base_of(name)[1] for name in names if not all(str(seed) in results.get(name, {}) for seed in SEEDS)}
    if len(inputs) > 1:
        import subprocess
        for suffix in sorted(inputs):
            mine = [name for name in names if base_of(name)[1] == suffix]
            subprocess.run([sys.executable, "-u", __file__, target, *mine], check=True)
        return
    for suffix in inputs:
        mine = [name for name in names if base_of(name)[1] == suffix]
        if INPUTS[suffix]:
            INPUTS[suffix]()
        fast = suffix
        spec = spec_for(target)
        recordings = lt.load_spec_recordings(spec)
        began = time.time()
        train = lt.examples(spec, recordings, list(spec.train))
        held_out = {}
        for rid in spec.evaluation:
            ts, _ = lt.pulse_of(recordings[rid])
            x = lt.inputs(spec, recordings[rid], ts)
            ok = np.isfinite(x).all(axis=1)
            held_out[rid] = (ts[ok], x[ok])
        print(f"{fast or 'usual'} inputs: {len(train.y)} training moments ({int(train.y.sum())} starts), "
              f"{time.time() - began:.0f} s", flush=True)
        for name in mine:
            for seed in SEEDS:
                if str(seed) in results.get(name, {}):
                    continue
                began = time.time()
                model = fit(train.x, train.y, seed, **VARIANTS[base_of(name)[0]])
                scored = {rid: (times, model.predict_proba(x)[:, 1]) for rid, (times, x) in held_out.items()}
                run = judged(spec, recordings, scored)
                results.setdefault(name, {})[str(seed)] = run
                path.write_text(json.dumps(results, indent=1))
                report(target, results)
                print(name, seed, {b: (p and (p["caught"], p["gestures"], p["threshold"])) for b, p in run["best"].items()},
                      f"{time.time() - began:.0f} s", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
