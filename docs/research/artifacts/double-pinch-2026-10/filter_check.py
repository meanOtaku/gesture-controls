"""Which high-pass filter best separates a pinch's shake from the rest of the motion?

A pinch contact is a short, sharp jolt; arm movement, turning and gravity leaking into the linear acceleration are slow.
A high-pass filter should keep the first and drop the second. The studies so far used a crude one (each axis less its
trailing 0.3 s mean). Here, causal filters a live detector could run are compared:

* the trailing 0.3 s mean, subtracted (the studies' filter so far);
* the first difference (each sample less the one before);
* Butterworth high-pass filters, order 2 and 4, at 1 to 16 Hz (`scipy.signal.sosfilt`, causal, one pass).

Each filters every axis of the linear accelerometer and the gyroscope; the "shake" is the magnitude over the three
axes. For each filter, on the camera-timed pinch contacts (`imu_models_check.py`'s labels) and the everyday activities
(`stability_check.py`'s stretches):

* **pinch peak**: the largest shake from 0 to 0.4 s after the contact;
* **over the floor**: the pinch peak divided by the median shake over the second before the contact (how far a pinch
  stands out of the motion just before it);
* **candidates a minute**: with the threshold set so 95% of pinch peaks reach it, the shake peaks (at least 0.3 s apart)
  that reach it in each activity, a minute. Fewer is better: that is what the later rules and the model must reject.

First, where a pinch's energy lies: the power spectrum of the linear acceleration over the 0.64 s from 0.1 s before
each contact, against the same window slid over each activity every 0.5 s, in bands up to 25 Hz (half the 50 Hz rate).

    uv run --project tools/label-trainer python docs/research/artifacts/double-pinch-2026-10/filter_check.py

Run from the repository root (under a minute). Writes filter/results.json and results.md.
"""
import importlib.util, json, time
from pathlib import Path
import numpy as np
from scipy.signal import butter, sosfilt

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("stability_check", HERE / "stability_check.py")
ST = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ST)
C, M, S, HZ = ST.C, ST.M, ST.S, ST.HZ

KEEP = 0.95
PEAK_AFTER_S = (0.0, 0.4)
FLOOR_S = (-1.0, -0.1)
SPECTRUM_S = (-0.1, 0.54)
BANDS = ((0, 2), (2, 5), (5, 10), (10, 15), (15, 25))


def filters():
    out = {"trailing 0.3 s mean subtracted": lambda x: x - M.trailing_mean(x, M.HIGHPASS),
           "first difference": lambda x: np.vstack([np.zeros((1, x.shape[1])), np.diff(x, axis=0)])}
    for order in (2, 4):
        for cut in (1, 3, 5, 8, 12, 16):
            sos = butter(order, cut, btype="highpass", fs=HZ, output="sos")
            out[f"Butterworth order {order}, {cut} Hz"] = lambda x, sos=sos: sosfilt(sos, x, axis=0)
    return out


def spectrum(x):
    """Power per frequency of a (samples, 3) window, summed over the axes."""
    x = x - x.mean(0)
    w = np.hanning(len(x))[:, None]
    return (np.abs(np.fft.rfft(x * w, axis=0)) ** 2).sum(1)


def main():
    t0 = time.time()
    out_dir = HERE / "filter"; out_dir.mkdir(exist_ok=True)
    recs = M.load_all()
    cam = [r for r in recs if r["kind"] == "camera"]
    stretches = ST.everyday_stretches(recs)
    names = list(dict.fromkeys(n for n, *_ in stretches))
    minutes = {n: sum((b - a) / S / 60 for m, _, a, b in stretches if m == n) for n in names}

    # Where the energy lies.
    n_spec = int(round((SPECTRUM_S[1] - SPECTRUM_S[0]) * HZ))
    freqs = np.fft.rfftfreq(n_spec, 1 / HZ)

    def window(r, t):
        k = int(np.searchsorted(r["grid"], t + SPECTRUM_S[0] * S))
        if k < 0 or k + n_spec > len(r["grid"]) or not r["gap_ok"][k:k + n_spec].all():
            return None
        return spectrum(r["x"][k:k + n_spec, :3])

    spectra = {"pinch contacts": [w for r in cam for c in r["contacts"] if (w := window(r, c)) is not None]}
    for name, r, a, b in stretches:
        spectra.setdefault(name, []).extend(w for t in np.arange(a, b - n_spec / HZ * S, 0.5 * S) if (w := window(r, t)) is not None)
    band_power = {}
    for name, rows in spectra.items():
        if rows:
            mean = np.mean(rows, axis=0)
            band_power[name] = {f"{lo}-{hi} Hz": float(mean[(freqs >= lo) & (freqs < hi if hi < 25 else freqs <= hi)].sum()) for lo, hi in BANDS}

    # Each filter.
    results = {"pinches": len(spectra["pinch contacts"]), "minutes": minutes, "band_power": band_power, "filters": {}}
    for fname, f in filters().items():
        per_sensor = {}
        for sensor, cols in (("accelerometer", slice(0, 3)), ("gyroscope", slice(3, 6))):
            shake = {r["name"]: np.linalg.norm(f(r["x"][:, cols]), axis=1) for r in recs}
            peaks, ratios = [], []
            for r in cam:
                for c in r["contacts"]:
                    s, fl = C.span(r, c, *PEAK_AFTER_S), C.span(r, c, *FLOOR_S)
                    if s.stop > s.start and fl.stop - fl.start > 10 and r["gap_ok"][fl.start:s.stop].all():
                        p = float(shake[r["name"]][s].max())
                        peaks.append(p); ratios.append(p / (float(np.median(shake[r["name"]][fl])) + 1e-12))
            thr = float(np.quantile(peaks, 1 - KEEP))
            counts = dict.fromkeys(names, 0)
            for name, r, a, b in stretches:
                s = C.span(r, a, 0, (b - a) / S)
                counts[name] += len(C.local_peaks(shake[r["name"]][s], thr))
            per_sensor[sensor] = {"pinch_peak_median": float(np.median(peaks)), "over_floor_median": float(np.median(ratios)),
                                  "threshold": thr, "candidates_per_minute": {n: counts[n] / minutes[n] for n in names}}
        results["filters"][fname] = per_sensor
    results["seconds"] = round(time.time() - t0, 1)
    (out_dir / "results.json").write_text(json.dumps(results, indent=1))

    lines = ["# Which high-pass filter separates a pinch from other motion?", "",
             f"{results['pinches']} camera-timed pinch contacts. Minutes: " + ", ".join(f"{n} {minutes[n]:.1f}" for n in names) + ".", "",
             "## Where the energy lies", "",
             "Mean power of the linear acceleration in each band, over 0.64 s windows (pinch: from 0.1 s before the contact)."
             " The last columns divide the pinch's power by each activity's: higher means the band favours the pinch.", "",
             "| Window | " + " | ".join(band_power["pinch contacts"]) + " |", "|---|" + "---:|" * len(BANDS)]
    for name, bp in band_power.items():
        lines.append(f"| {name} | " + " | ".join(f"{v:.3g}" for v in bp.values()) + " |")
    lines += ["", "| Pinch ÷ | " + " | ".join(band_power["pinch contacts"]) + " |", "|---|" + "---:|" * len(BANDS)]
    for name, bp in band_power.items():
        if name != "pinch contacts":
            lines.append(f"| {name} | " + " | ".join(f"{band_power['pinch contacts'][b] / (v + 1e-12):.2f}" for b, v in bp.items()) + " |")
    for sensor in ("accelerometer", "gyroscope"):
        lines += ["", f"## Filters on the {sensor}", "",
                  f"Threshold keeps {KEEP:.0%} of pinch peaks; cells are candidate peaks a minute (lower is better).", "",
                  "| Filter | Pinch peak | Over the floor | " + " | ".join(names) + " | All activities |",
                  "|---|---:|---:|" + "---:|" * (len(names) + 1)]
        total = sum(minutes.values())
        for fname, v in results["filters"].items():
            e = v[sensor]
            cpm = e["candidates_per_minute"]
            allr = sum(cpm[n] * minutes[n] for n in names) / total
            lines.append(f"| {fname} | {e['pinch_peak_median']:.3g} | {e['over_floor_median']:.2f}× | "
                         + " | ".join(f"{cpm[n]:.1f}" for n in names) + f" | {allr:.1f} |")
    lines += ["", f"{results['seconds']} s."]
    (out_dir / "results.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
