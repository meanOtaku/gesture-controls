"""Collect existing evidence only. Run once in the source checkout; never changes recordings.
Figure regeneration does NOT require rerunning this collector or external experiment directories.
"""
import argparse
import csv
import io
import json
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import tarfile
from common import HERE, ROOT, digest, read_json, rows, effective, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--multiclass-dir', type=Path, default=ROOT.parent/'gesture-controls-experiments/cnnv2-multiclass-20261116')
    args = parser.parse_args()
    dest = HERE/'data'
    ledger = []
    def copy(src, rel, status):
        src = Path(src)
        out = dest/rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, out)
        origin = str(src.relative_to(ROOT)) if src.is_relative_to(ROOT) else 'external-multiclass/'+str(src.relative_to(args.multiclass_dir))
        ledger.append({'path': str(out.relative_to(HERE)), 'source': origin, 'sha256': digest(out), 'bytes': out.stat().st_size, 'status': status})
        return out
    rev = ROOT/'docs/paper/revision-assets'
    for name in ['evidence-audit.json', 'hand-labelled-replay.json', 'report-figure-data.json']:
        copy(rev/name, 'historical/'+name, 'stored historical audit/replay; not a new inference run')
    copy(ROOT/'docs/research/artifacts/cnn-all-days-2026-11/results.md', 'historical/day-transfer.md', 'historical camera-labelled exploration')
    copy(ROOT/'docs/research/cnn-motion-hangover-2026-11.md', 'documented/motion-hangover.md', 'documented synthetic-splice study; raw replay output not recovered')
    copy(ROOT/'docs/research/artifacts/training-improvements-2026-11/final-models.md', 'documented/paired-models.md', 'archived rounded summary; original matching run artifacts not recovered')
    bench = ROOT/'docs/research/artifacts/pinch-cnn-v2-2026-11'
    copy(bench/'FINDINGS.md', 'v2/FINDINGS.md', 'exploratory study context')
    copy(bench/'README.md', 'v2/PROTOCOL.md', 'historical benchmark protocol')
    for name in ['ref-ae0a22bf', 'final-branches-warp-env-m3-gate600q10', 'final-branches-warp-env-m3-overlay2-gate600q10', 'app-trained-v2-pinch_in-6e2053d0']:
        copy(bench/'results'/f'{name}.json', f'v2/{name}.json', 'saved threshold sweep; use stored chosen threshold, not test optimum')
    ext = args.multiclass_dir
    for name in ['results.json', 'snapshot.json', 'audit.json', 'verification.json', 'REPORT.md']:
        copy(ext/name, 'multiclass/'+name, 'exploratory delayed-state study; historical reused test cohort')
    snapshot = read_json(ext/'snapshot.json')
    assert digest(ext/'snapshot.json') == read_json(ext/'results.json')['snapshot_sha256']
    for p in sorted((ext/'predictions').glob('*.npz')):
        copy(p, 'multiclass/predictions/'+p.name, 'saved prediction vectors; no model fitting required')
    for seed in (17, 18, 19):
        copy(ext/f'model-seed-{seed}.pt', f'multiclass/model-seed-{seed}.pt', 'archived checkpoint; do not activate')
    for name in ['run.py', 'report.py']:
        copy(ext/name, 'multiclass/original-runner/'+name, 'unaltered original runner; optional CUDA retraining only')
    # Recover exact trainer code, not today's incompatible trainer. Do not extract untrusted archive paths.
    with tarfile.open(ext/'inputs.tar.gz') as archive:
        for member in archive.getmembers():
            rel = Path(member.name)
            if not (member.isfile() and len(rel.parts) == 3 and rel.parts[:2] == ('src', 'label_trainer') and rel.suffix == '.py'):
                continue
            handle = archive.extractfile(member)
            assert handle is not None
            data = handle.read()
            import hashlib
            assert hashlib.sha256(data).hexdigest() == snapshot['files'][member.name]
            out = dest/'multiclass/frozen-trainer'/rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
            ledger.append({'path': str(out.relative_to(HERE)), 'source': 'external-multiclass/inputs.tar.gz!'+member.name, 'sha256': digest(out), 'bytes': len(data), 'status': 'exact original trainer source from frozen archive'})
    # Validate original raw input identities against repository copies without changing the old global manifest.
    raw_checks = []
    for rel, expected in snapshot['files'].items():
        if not rel.startswith('data/'):
            continue
        p = ROOT/'data/recordings/Hand labeled'/Path(rel).relative_to('data')
        ok = p.is_file() and digest(p) == expected
        raw_checks.append({'path': str(p.relative_to(ROOT)), 'expected_sha256': expected, 'matches_frozen_training_input': ok})
    write_json(dest/'multiclass/repository-input-check.json', raw_checks)
    # A real observed annotation-correction excerpt. Keep exact timestamps and CSV cell values.
    rid = 'gesture-dataset-pinch_hold-2026-11-03T01-05-59.434Z'
    folder = ROOT/'data/recordings/Hand labeled'/rid
    ppg = list(rows(folder/'ppg.csv'))
    changed = next(r for r in ppg if effective(r.get('label',''), r.get('manual_label','')) != r.get('label',''))
    centre = int(changed['timestamp_ns'])
    low, high = centre-3_000_000_000, centre+10_000_000_000
    for stream in ('ppg', 'imu'):
        source = folder/f'{stream}.csv'
        subset = [r for r in rows(source) if low <= int(r['timestamp_ns']) <= high]
        assert subset
        out = dest/f'telemetry/{stream}.csv'
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open('w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(subset[0])); w.writeheader(); w.writerows(subset)
        ledger.append({'path': str(out.relative_to(HERE)), 'source': str(source.relative_to(ROOT)), 'source_sha256': digest(source), 'sha256': digest(out), 'bytes': out.stat().st_size, 'status': 'exact recorded row subset; no sensor or label edits'})
    write_json(dest/'telemetry/selection.json', {'recording': rid, 'origin_timestamp_ns': int(ppg[0]['timestamp_ns']), 'low_ns': low, 'high_ns': high, 'selection': 'first effective-label correction; 3 seconds before and 10 after', 'purpose': 'observed annotation example, not model output'})
    # Fresh audit has a different scope/date from the historical 37-export inventory.
    stream = runpy.run_path(str(rev/'audit_evidence.py'))['stream']
    inventory = []
    for folder in sorted((ROOT/'data/recordings/Hand labeled').iterdir()):
        if not folder.is_dir() or not (folder/'ppg.csv').is_file() or not (folder/'imu.csv').is_file():
            continue
        record = {'id': folder.name, 'files': {}}
        for kind in ('ppg', 'imu'):
            p = folder/f'{kind}.csv'
            record[kind] = stream(p)
            record['files'][kind] = {'path': str(p.relative_to(ROOT)), 'sha256': digest(p)}
        inventory.append(record)
    write_json(dest/'current-inventory.json', inventory)
    # Ledger also covers derived selections/manifests, and every bundled original vector/checkpoint.
    listed = {x['path'] for x in ledger}
    for p in sorted(dest.rglob('*')):
        if p.is_file() and str(p.relative_to(HERE)) not in listed:
            ledger.append({'path': str(p.relative_to(HERE)), 'source': 'collect.py derived from identified original sources', 'sha256': digest(p), 'bytes': p.stat().st_size, 'status': 'collection metadata or current read-only audit'})
    write_json(HERE/'sources.json', {'source_commit': subprocess.check_output(['git','rev-parse','HEAD'], cwd=ROOT, text=True).strip(), 'scope': 'existing evidence only; no retraining or new hardware collection; original recordings and global manifest unchanged', 'files': ledger})
    print(f'Collected {len(ledger)} evidence files; {len(inventory)} current exports; frozen raw inputs matching {sum(x["matches_frozen_training_input"] for x in raw_checks)}/{len(raw_checks)}')

if __name__ == '__main__':
    main()
