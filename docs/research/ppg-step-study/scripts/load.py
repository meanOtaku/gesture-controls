"""Loads the Downloads recordings as the trainer reads them, with unmarked rows as rest."""
import glob, re, tempfile
from pathlib import Path
from label_trainer.csv_io import load_recording
from label_trainer.label_train import repair_millisecond_ppg_timestamps

ALIASES = {"pinching": "pinch"}
SKIP = {"unlabeled", "hand_twit_clockwise_and_anti_clockwise", "pinch_open"}

def recordings():
    out = []
    tmp = Path(tempfile.mkdtemp())
    for f in sorted(glob.glob(str(Path.home() / "Downloads/gesture-dataset-*.csv"))):
        name = Path(f).name[len("gesture-dataset-"):-len(".csv")]
        gesture = re.sub(r"-\d{4}-\d\d-\d\dT.*$", "", name)
        if gesture in SKIP:
            continue
        lines = Path(f).read_text().splitlines()
        fixed = [l if l.startswith("#") or l.startswith("timestamp_ns") else (l + "rest" if l.endswith(",") else l) for l in lines]
        fixed = [re.sub(r",pinching$", ",pinch", l) for l in fixed]
        p = tmp / Path(f).name
        p.write_text("\n".join(fixed) + "\n")
        r = repair_millisecond_ppg_timestamps(load_recording(p))
        labels = {l for l in r.raw_labels}
        if labels <= {"rest"}:
            continue  # unmarked: skipped
        day = re.search(r"\d{4}-\d\d-\d\d", name).group(0)
        out.append((name, ALIASES.get(gesture, gesture), day, r))
    return out
