"""Could `pinch_out` use a lower cut-off while a grab is under way?

After `pinch_in` has started a grab, a `pinch_out` is the only thing the user can do next, so a release is far likelier
than at any other time. This replays the live `pinch_out-motion` model (`trained-models/pinch_out-motion/model.cnn`, cut-off
0.95) over the 11 recordings it never trained on, but only inside each hold: from 0.6 s after a labelled `pinch_in` start
(when the grab would have begun) to the end of the release's match window.

For each cut-off: how many releases it catches, and how many times it fires earlier in the hold than the release, which
would drop the grab while the fingers are still together. Hold time is the denominator for those false releases.

    tools/label-trainer/.venv/bin/python docs/research/artifacts/training-improvements-2026-11/release_threshold.py
"""
from __future__ import annotations

import json

import numpy as np

from experiment import HERE, ROOT, UNSEEN, spec_for
from label_trainer import cnn, label_train as lt, ppg_onset
from label_trainer.events import detect

GRAB_AFTER_MS = 600
THRESHOLDS = (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.97, 0.99)


def main() -> None:
    spec = spec_for("pinch_out")
    recordings = lt.load_spec_recordings(spec)
    model = (ROOT / "trained-models" / "pinch_out-motion" / "model.cnn").read_bytes()
    earliest_ms, latest_ms = ppg_onset.match_window_ms(spec.decision_delay_ms)
    rows = {t: {"releases": 0, "caught": 0, "falseReleases": 0, "holdSeconds": 0.0, "unseenReleases": 0, "unseenCaught": 0,
                "unseenFalse": 0} for t in THRESHOLDS}
    for rid in spec.evaluation:
        recording = recordings[rid]
        held = ppg_onset.holds(recording.timestamps_ns, recording.raw_labels)
        grabs = sorted(s for s, _, label in held if label == "pinch_in")
        releases = sorted(s for s, _, label in held if label == "pinch_out")
        if not releases:
            continue
        ts, _ = lt.pulse_of(recording)
        x = lt.inputs(spec, recording, ts)
        ok = np.isfinite(x).all(axis=1)
        times, scores = ts[ok], cnn.predict(model, x[ok])
        unseen = rid.endswith(UNSEEN)
        for release in releases:
            before = [g for g in grabs if g < release]
            if not before or (release - before[-1]) > 30e9:
                continue
            start = before[-1] + GRAB_AFTER_MS * 1_000_000
            window = (release + earliest_ms * 1_000_000, release + latest_ms * 1_000_000)
            inside = (times >= start) & (times <= window[1])
            if inside.sum() < 5 or start >= window[0]:
                continue
            for t in THRESHOLDS:
                # Within a hold only the first firing matters: it ends the grab.
                rises = [rise for rise, _ in detect(times[inside], scores[inside], lt.policy_for(t, spec.trigger))]
                row = rows[t]
                row["releases"] += 1
                row["unseenReleases"] += unseen
                row["holdSeconds"] += (window[0] - start) / 1e9
                first = rises[0] if rises else None
                if first is not None and first < window[0]:
                    row["falseReleases"] += 1
                    row["unseenFalse"] += unseen
                elif first is not None:
                    row["caught"] += 1
                    row["unseenCaught"] += unseen
    lines = ["# A lower `pinch_out` cut-off during a grab", "",
             "The live `pinch_out-motion` model inside each hold of the 11 recordings it never trained on (see",
             "`release_threshold.py`). A false release is a firing before the labelled release: the grab would drop early. In",
             "brackets, the three sessions of 9 Nov alone.", "",
             "| cut-off | releases caught | false releases | false releases an hour of holding |", "|---:|---|---|---:|"]
    for t, row in rows.items():
        hours = row["holdSeconds"] / 3600
        lines.append(f"| {t:g} | {row['caught']}/{row['releases']} ({row['unseenCaught']}/{row['unseenReleases']}) | "
                     f"{row['falseReleases']} ({row['unseenFalse']}) | {row['falseReleases'] / hours:.0f} |")
    (HERE / "release-threshold.md").write_text("\n".join(lines) + "\n")
    (HERE / "release-threshold.json").write_text(json.dumps(rows, indent=1))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
