"""Read-only paper audit. Run from any directory with Python 3 (stdlib only).

Counts are PPG-sampled label runs, NOT the trainer's eligible event denominators.
No dataset, label, trained model or original paper is modified.
"""
from pathlib import Path
import collections
import csv
import hashlib
import json
import subprocess
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent


def rows(path):
    with path.open(newline='', encoding='utf-8-sig') as f:
        yield from csv.DictReader(line for line in f if not line.startswith('#') and line.strip())


def effective(label, manual):
    return ('' if manual == '-' else manual) if manual else label


def stream(path):
    counts, runs, manual = collections.Counter(), collections.Counter(), collections.Counter()
    first = last = None
    previous = None
    digest = hashlib.sha256()
    n = changed = 0
    for row in rows(path):
        stamp = int(row['timestamp_ns'])
        first = stamp if first is None else first
        last = stamp
        label = row.get('label', '')
        override = row.get('manual_label', '')
        actual = effective(label, override)
        counts[actual] += 1
        manual[override] += 1
        changed += actual != label
        if actual != previous and actual:
            runs[actual] += 1
        previous = actual
        raw = {k: v for k, v in row.items() if k not in ('label', 'manual_label')}
        digest.update((json.dumps(raw, sort_keys=True, separators=(',', ':')) + '\n').encode())
        n += 1
    return dict(rows=n, duration_s=(last-first)/1e9 if first is not None and last is not None else 0,
                first_timestamp_ns=first, last_timestamp_ns=last,
                effective_label_rows=dict(counts), sampled_label_runs=dict(runs),
                manual_label_rows=dict(manual), changed_label_rows=changed,
                sensor_columns_sha256=digest.hexdigest())


def main():
    assert effective('pinch', '') == 'pinch'
    assert effective('pinch', '-') == ''
    assert effective('pinch', 'pinch_out') == 'pinch_out'
    assert effective('pinch', 'left_out') == 'left_out'
    records = []
    folders = sorted((ROOT/'data/recordings/Hand labeled').iterdir())
    for folder in folders:
        if not folder.is_dir():
            continue
        item: dict[str, Any] = dict(session_id=folder.name, path=str(folder.relative_to(ROOT)))
        metadata = folder/'recording.json'
        item['recording_id'] = json.loads(metadata.read_text()).get('recording_id') if metadata.exists() else None
        for name in ('ppg', 'imu'):
            file = folder/(name+'.csv')
            item[name] = stream(file) if file.exists() else None
        labels = folder/'manual_labels.json'
        item['manual_interval_count'] = len(json.loads(labels.read_text())) if labels.exists() else None
        item['same_id_other_copies'] = []
        for other in (ROOT/'data/recordings').glob('**/'+folder.name):
            if other == folder or not other.is_dir():
                continue
            entry: dict[str, Any] = dict(path=str(other.relative_to(ROOT)))
            for name in ('ppg', 'imu'):
                f = other/(name+'.csv')
                if f.exists() and item[name]:
                    info = stream(f)
                    entry[name+'_sensor_columns_identical'] = info['sensor_columns_sha256'] == item[name]['sensor_columns_sha256']
            item['same_id_other_copies'].append(entry)
        records.append(item)
    models = []
    for manifest in sorted((ROOT/'trained-models').glob('*/manifest.json')):
        m = json.loads(manifest.read_text())
        prov = m.get('provenance', {})
        model = manifest.parent/m['model']['file']
        actual = hashlib.sha256(model.read_bytes()).hexdigest() if model.exists() else None
        train = set(prov.get('trainRecordings', []))
        evaluation = set(prov.get('evaluationRecordings', []))
        models.append(dict(path=str(manifest.relative_to(ROOT)), model_id=m.get('modelId'),
                           target=m.get('targetLabel'), preprocessing=m.get('preprocessing'),
                           thresholds=m.get('thresholds'), window=m.get('window'),
                           model_sha256=actual, declared_sha256=m['model'].get('sha256'),
                           model_hash_matches=actual == m['model'].get('sha256'),
                           train_count=len(train), evaluation_count=len(evaluation),
                           id_overlap=sorted(train & evaluation), provenance=prov))
    groups = collections.defaultdict(list)
    for item in records:
        if item['ppg'] and item['imu']:
            groups[(item['ppg']['sensor_columns_sha256'],item['imu']['sensor_columns_sha256'])].append(item['session_id'])
    by_id = {}
    for key, names in groups.items():
        for r in records:
            if r['session_id'] in names:
                by_id[r['session_id']] = key
                if r['recording_id']:
                    by_id[r['recording_id']] = key
    for m in models:
        p = m['provenance']
        train = p.get('trainRecordings', [])
        evaluation = p.get('evaluationRecordings', [])
        m['resolved_train_ids'] = [x for x in train if x in by_id]
        m['resolved_evaluation_ids'] = [x for x in evaluation if x in by_id]
        train_keys = {by_id[x] for x in train if x in by_id}
        eval_keys = {by_id[x] for x in evaluation if x in by_id}
        m['sensor_alias_overlap_resolved_subset'] = [list(k) for k in sorted(train_keys & eval_keys)]
        m['sensor_alias_check_complete'] = len(m['resolved_train_ids']) == len(train) and len(m['resolved_evaluation_ids']) == len(evaluation)
    unique_minutes = sum(next(r['ppg']['duration_s'] for r in records if r['session_id'] == names[0]) for names in groups.values())/60
    audit = dict(unique_sensor_pairs=len(groups), unique_sensor_pair_minutes=unique_minutes,
                 audited_commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
                 counting_rule='PPG-sampled effective-label contiguous runs; not trainer eligible starts',
                 records=records, models=models,
                 duplicate_sensor_groups=[v for v in groups.values() if len(v)>1])
    OUT.mkdir(exist_ok=True)
    (OUT/'evidence-audit.json').write_text(json.dumps(audit, indent=2)+'\n')
    with (OUT/'hand-labelled-inventory.csv').open('w',newline='') as f:
        fields=['session_id','ppg_duration_s','ppg_rows','manual_ppg_rows','changed_ppg_rows','pinch_in_runs','pinch_hold_runs','pinch_out_runs','left_out_runs','manual_interval_count']
        w=csv.DictWriter(f,fieldnames=fields,lineterminator='\n');w.writeheader()
        for r in records:
            p=r['ppg'] or {}; c=p.get('sampled_label_runs',{})
            w.writerow(dict(session_id=r['session_id'],ppg_duration_s=p.get('duration_s'),ppg_rows=p.get('rows'),manual_ppg_rows=sum(v for k,v in p.get('manual_label_rows',{}).items() if k),changed_ppg_rows=p.get('changed_label_rows'),pinch_in_runs=c.get('pinch_in',0),pinch_hold_runs=c.get('pinch_hold',0),pinch_out_runs=c.get('pinch_out',0),left_out_runs=c.get('left_out',0),manual_interval_count=r['manual_interval_count']))
    print(json.dumps(dict(recordings=len(records), ppg_minutes=sum(r['ppg']['duration_s'] for r in records if r['ppg'])/60,
                          sessions_with_manual_ppg=sum(any(k for k in r['ppg']['manual_label_rows']) for r in records if r['ppg']),
                          changed_ppg_rows=sum(r['ppg']['changed_label_rows'] for r in records if r['ppg']),
                          sampled_runs=dict(sum((collections.Counter(r['ppg']['sampled_label_runs']) for r in records if r['ppg']),collections.Counter())),
                          models=[{k:m[k] for k in ('path','train_count','evaluation_count','model_hash_matches')} for m in models]),indent=2))


if __name__ == '__main__':
    main()
