"""Loads the study's recordings as the trainer reads them, with unmarked rows as rest.

They are read from data/recordings/2026-10-downloads/ in the repo (data/recordings.manifest.json lists them and
`python3 scripts/recordings_manifest.py check` confirms they are unchanged), else from ~/Downloads where they were exported.

Only the recordings listed in the manifest are read: the 26 these studies were run on. Recordings added to the folder
later (the 2026-10-14 session) are left alone, so every documented number reproduces exactly and the new recordings stay
unseen until they are deliberately used as a test set. Set PPG_STUDY_FILES=all to read every file in the folder.
"""
import glob, json, os, re, tempfile
from pathlib import Path
from label_trainer.csv_io import load_recording
from label_trainer.label_train import repair_millisecond_ppg_timestamps

ALIASES = {"pinching": "pinch"}
SKIP = {"unlabeled", "hand_twit_clockwise_and_anti_clockwise", "pinch_open"}

def recordings():
    out = []
    tmp = Path(tempfile.mkdtemp())
    repo_copy = Path(__file__).resolve().parents[4] / "data" / "recordings" / "2026-10-downloads"
    source = repo_copy if repo_copy.is_dir() else Path.home() / "Downloads"
    manifest = Path(__file__).resolve().parents[4] / "data" / "recordings.manifest.json"
    listed = None
    if os.environ.get("PPG_STUDY_FILES") != "all" and manifest.is_file():
        listed = {Path(e["file"]).name for e in json.loads(manifest.read_text())["recordings"]}
    for f in sorted(glob.glob(str(source / "gesture-dataset-*.csv"))):
        if listed is not None and Path(f).name not in listed:
            continue
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
