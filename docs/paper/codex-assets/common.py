"""Shared file/label rules. No fitting, downloads, actuation or dataset mutations."""
from pathlib import Path
import csv
import hashlib
import json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]

def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))

def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + '\n', encoding='utf-8')

def rows(path):
    with Path(path).open(newline='', encoding='utf-8-sig') as f:
        yield from csv.DictReader(line for line in f if line.strip() and not line.startswith('#'))

def effective(label, manual):
    return ('' if manual == '-' else manual) if manual else label

def spans(times, labels):
    """Half-open runs ending at next sample; final run ends at last saved timestamp."""
    if not len(times):
        return []
    out = []
    start = 0
    for i in range(1, len(times)):
        if labels[i] != labels[start]:
            out.append((float(times[start]), float(times[i]), str(labels[start])))
            start = i
    out.append((float(times[start]), float(times[-1]), str(labels[start])))
    return out
